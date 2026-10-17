import path from 'path';
import { CONCURRENCY_LIMITS, getFfmpegPath } from './config.js';
import { formatDuration } from './utils.js';
import { spawnTranscodeJob, killAllActiveJobs, buildFfmpegArgs } from './transcoder.js';

/**
 * Formats seconds into a concise #d #h #m or #h#m or #m#s ETA string.
 * Adds days if total duration is 24 hours (86,400s) or more.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatEta(totalSeconds) {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return '0m00s';

  const days = Math.floor(totalSeconds / 86400);
  const hrs = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);

  const pad = (n) => String(n).padStart(2, '0');

  if (days > 0) {
    return `${days}d ${pad(hrs)}h ${pad(mins)}m`;
  }
  if (hrs > 0) {
    return `${pad(hrs)}h ${pad(mins)}m`;
  }
  return `${mins}m${pad(secs)}s`;
}

/**
 * Tracks speed samples over a rolling 2-minute (120,000 ms) window to compute moving average speed.
 */
export class RollingSpeedTracker {
  constructor(windowMs = 120000) {
    this.windowMs = windowMs;
    this.samples = []; // [{ timestamp, speed }]
  }

  /**
   * Adds a new speed measurement sample.
   * @param {number} speed
   */
  addSample(speed) {
    if (!speed || isNaN(speed) || speed <= 0) return;
    const now = Date.now();
    this.samples.push({ timestamp: now, speed });
    this.cleanOldSamples(now);
  }

  /**
   * Purges samples older than the 2-minute rolling window cutoff.
   * @param {number} now
   */
  cleanOldSamples(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Returns moving average speed across the rolling 2-minute window.
   * @param {number} fallbackSpeed
   * @returns {number}
   */
  getAverageSpeed(fallbackSpeed = 1.0) {
    this.cleanOldSamples();
    if (this.samples.length === 0) return fallbackSpeed;
    const sum = this.samples.reduce((acc, s) => acc + s.speed, 0);
    return sum / this.samples.length;
  }
}

/**
 * Calculates how many audio streams in a candidate item require transcoding.
 * Multi-audio track items transcode slower in proportion to stream count.
 * @param {Object} item
 * @returns {number}
 */
export function getAudioTranscodeWeight(item) {
  if (!item || !item.plan || !item.plan.audioStreamPlans) return 1;
  const transcodeStreamsCount = item.plan.audioStreamPlans.filter((p) => p.needsTranscode).length;
  return Math.max(1, transcodeStreamsCount);
}

/**
 * Calculates video transcoding workload units for an item based on duration,
 * resolution (normalized to 1080p), HDR 10-bit color space factor, and video stream count.
 *
 * @param {Object} item
 * @returns {number} Workload units
 */
export function getVideoTranscodeWorkload(item) {
  if (!item || !item.metadata) return 0;
  const duration = item.metadata.duration || 0;
  const w = item.metadata.width || 0;
  const h = item.metadata.height || 0;

  // Normalized resolution factor relative to 1080p Full HD (1920x1080 = 2,073,600 pixels)
  const pixelCount = (w > 0 && h > 0) ? (w * h) : (1920 * 1080);
  const resolutionFactor = pixelCount / (1920 * 1080);

  // HDR 10-bit color space factor (10-bit HDR encoding takes ~1.4x longer per pixel)
  const hdrFactor = item.metadata.isHdr ? 1.4 : 1.0;

  // Video stream count multiplier
  const streamCount = Math.max(1, item.metadata.videoStreamCount || 1);

  return duration * resolutionFactor * hdrFactor * streamCount;
}

export class BatchScheduler {
  /**
   * @param {Object} [params]
   * @param {Array} [params.videoQueue]
   * @param {Array} [params.audioOnlyQueue]
   * @param {number} [params.totalVideoPoolDuration]
   * @param {number} [params.totalAudioOnlyPoolDuration]
   * @param {number} [params.qualityNum] User target video quality number (default: 24)
   */
  constructor({ videoQueue = [], audioOnlyQueue = [], totalVideoPoolDuration = 0, totalAudioOnlyPoolDuration = 0, qualityNum = 24 } = {}) {
    this.videoQueue = [...videoQueue];
    this.audioOnlyQueue = [...audioOnlyQueue];

    this.qualityNum = qualityNum;

    this.initialVideoCount = videoQueue.length;
    this.initialAudioCount = audioOnlyQueue.length;
    this.totalJobsCount = this.initialVideoCount + this.initialAudioCount;

    this.totalVideoPoolDuration = totalVideoPoolDuration;
    this.totalAudioOnlyPoolDuration = totalAudioOnlyPoolDuration;

    this.completedVideoCount = 0;
    this.completedAudioCount = 0;
    this.failedVideoCount = 0;
    this.failedAudioCount = 0;

    // Slot states and rolling speed trackers
    this.activeVideoSlot = null; // { fileItem, percent, speed, currentTimeSec, totalDuration, tracker }
    this.activeAudioSlots = new Array(CONCURRENCY_LIMITS.MAX_AUDIO_CONCURRENT).fill(null);

    // Probing state
    this.isProbing = true;
    this.probingStatusText = 'PROBING: 0/0 (0.0%)';

    this.isHalted = false;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  /**
   * Updates probing progress string to display in slot status line before probing finishes.
   * @param {number} processed
   * @param {number} total
   * @param {string} percentStr
   */
  updateProbingStatus(processed, total, percentStr) {
    this.isProbing = true;
    this.probingStatusText = `PROBING: ${processed}/${total} (${percentStr}%)`;
    this.renderProgressLine();
  }

  /**
   * Replaces probing status with pool ETA once probing is complete.
   */
  markProbingComplete() {
    this.isProbing = false;
    this.renderProgressLine();
    this.checkAndFillSlots();
  }

  /**
   * Dynamically enqueues a newly probed item and immediately starts transcoding if slots are idle.
   * @param {Object} fileItem
   */
  enqueueItem(fileItem) {
    if (fileItem.plan.transcodeVideo) {
      this.videoQueue.push(fileItem);
      this.totalVideoPoolDuration += fileItem.metadata.duration || 0;
      this.initialVideoCount++;
    } else if (fileItem.plan.needsTranscode) {
      this.audioOnlyQueue.push(fileItem);
      this.totalAudioOnlyPoolDuration += fileItem.metadata.duration || 0;
      this.initialAudioCount++;
    }
    this.totalJobsCount = this.initialVideoCount + this.initialAudioCount;
    this.checkAndFillSlots();
  }

  /**
   * Calculates overall remaining video & audio pool durations and estimated time remaining (ETA)
   * using rolling 2-minute moving average speeds, resolution normalization, HDR color factor, and multi-audio-track weighting.
   */
  calculatePoolEta() {
    // 1. Video Pool Remaining Workload & ETA (Resolution + HDR Color Space + Stream Count + Duration)
    let remainingVideoWorkload = this.videoQueue.reduce((acc, item) => acc + getVideoTranscodeWorkload(item), 0);
    let videoProcessingRate = 3.0; // Baseline fallback rate (workload units per wall-clock second)

    if (this.activeVideoSlot) {
      const activeItem = this.activeVideoSlot.item;
      const totalItemWorkload = getVideoTranscodeWorkload(activeItem);
      const activeRemPercent = Math.max(0, 1 - (this.activeVideoSlot.percent / 100));
      remainingVideoWorkload += (totalItemWorkload * activeRemPercent);

      const movingAvgSpeed = this.activeVideoSlot.tracker.getAverageSpeed(3.0);
      const activeWorkloadFactor = totalItemWorkload / Math.max(1, activeItem.metadata.duration || 1);
      videoProcessingRate = movingAvgSpeed * activeWorkloadFactor;
    }

    const videoEtaSec = remainingVideoWorkload > 0 ? (remainingVideoWorkload / Math.max(0.1, videoProcessingRate)) : 0;

    // 2. Audio-Only Pool Remaining Duration & ETA
    let remainingWeightedAudioWork = this.audioOnlyQueue.reduce((acc, item) => {
      const weight = getAudioTranscodeWeight(item);
      return acc + ((item.metadata.duration || 0) * weight);
    }, 0);

    let activeAudioWorkloadRatesSum = 0;
    let activeAudioSlotsCount = 0;

    this.activeAudioSlots.forEach((slot) => {
      if (slot) {
        const audioWeight = getAudioTranscodeWeight(slot.item);
        const remMediaSec = Math.max(0, slot.totalDuration - slot.currentTimeSec);
        remainingWeightedAudioWork += (remMediaSec * audioWeight);
        activeAudioSlotsCount++;

        const slotAvgSpeed = slot.tracker.getAverageSpeed(40.0);
        activeAudioWorkloadRatesSum += slotAvgSpeed;
      }
    });

    const effectiveAudioWorkRate = activeAudioWorkloadRatesSum > 0
      ? activeAudioWorkloadRatesSum
      : (activeAudioSlotsCount > 0 ? activeAudioSlotsCount * 40.0 : 40.0);

    const audioEtaSec = remainingWeightedAudioWork > 0 ? (remainingWeightedAudioWork / effectiveAudioWorkRate) : 0;

    // Overall ETA is max of video queue ETA and audio queue ETA
    const overallEtaSec = Math.max(videoEtaSec, audioEtaSec);

    return {
      remainingVideoWorkload,
      remainingWeightedAudioWork,
      overallEtaSec,
      etaFormatted: formatEta(overallEtaSec)
    };
  }

  /**
   * Renders single-line overwriting progress string across all active slots.
   */
  renderProgressLine() {
    if (this.isHalted) return;

    // Video Slot String
    let vStr = 'Idle';
    if (this.activeVideoSlot) {
      const avgSpeed = this.activeVideoSlot.tracker.getAverageSpeed(this.activeVideoSlot.speed).toFixed(1);
      vStr = `${this.activeVideoSlot.percent.toFixed(1)}% (${avgSpeed}x)`;
    } else if (this.initialVideoCount > 0 && this.videoQueue.length === 0 && !this.isProbing) {
      vStr = 'Done';
    }

    // Audio Slots Strings
    const aStrs = this.activeAudioSlots.map((slot, idx) => {
      if (slot) {
        const avgSpeed = slot.tracker.getAverageSpeed(slot.speed).toFixed(1);
        return `A${idx + 1}: ${slot.percent.toFixed(1)}% (${avgSpeed}x)`;
      }
      return `A${idx + 1}: Idle`;
    });

    const rightSideText = this.isProbing
      ? this.probingStatusText
      : `ETA: ${this.calculatePoolEta().etaFormatted}`;

    const line = `[SLOTS] V: ${vStr} | ${aStrs.join(' | ')} | ${rightSideText}`;
    process.stdout.write(`\r\x1b[K${line}`);
  }

  /**
   * Dumps job banner details on new lines when a job starts or finishes.
   * @param {string} bannerHeader
   * @param {Object} fileItem
   */
  logJobBanner(bannerHeader, fileItem) {
    const dir = path.dirname(fileItem.filePath);
    const ext = path.extname(fileItem.filePath);
    const baseName = path.basename(fileItem.filePath, ext);
    const finalOutputPath = path.join(dir, `${baseName}${fileItem.plan.targetExt || '.webm'}`);

    const ffmpegPath = getFfmpegPath();
    const args = buildFfmpegArgs(fileItem.filePath, finalOutputPath, fileItem.plan, this.qualityNum);
    const fullCommand = `"${ffmpegPath}" ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;

    process.stdout.write('\n');
    console.log(`================================================================================`);
    console.log(bannerHeader);
    console.log(`Input File     : "${fileItem.filePath}"`);
    console.log(`Output Target  : "${finalOutputPath}"`);
    console.log(`Video Codec    : ${fileItem.plan.targetVideoCodecDisplay}`);
    console.log(`Audio Codec    : ${fileItem.plan.targetAudioCodecDisplay}`);
    console.log(`Subtitles      : ${fileItem.plan.subtitleAction}`);
    console.log(`Duration       : ${formatDuration(fileItem.metadata.duration)}`);
    console.log(`FFmpeg Command : ${fullCommand}`);
    console.log(`================================================================================`);
  }

  /**
   * Fills idle slots and spawns concurrent FFmpeg processes.
   */
  checkAndFillSlots() {
    if (this.isHalted) return;

    // Check Video Queue Slot
    if (!this.activeVideoSlot && this.videoQueue.length > 0) {
      const item = this.videoQueue.shift();
      const slotLabel = 'V';

      this.activeVideoSlot = {
        item,
        percent: 0,
        speed: 1.0,
        currentTimeSec: 0,
        totalDuration: item.metadata.duration || 0,
        tracker: new RollingSpeedTracker(120000)
      };

      const completedCount = this.completedVideoCount + this.completedAudioCount + this.failedVideoCount + this.failedAudioCount + 1;
      this.logJobBanner(`[JOB START - Video Slot V] (${completedCount}/${this.totalJobsCount})`, item);

      spawnTranscodeJob(item, {
        slotLabel,
        qualityNum: this.qualityNum,
        onProgressUpdate: (data) => {
          if (this.activeVideoSlot) {
            this.activeVideoSlot.percent = data.percent;
            this.activeVideoSlot.speed = data.speed;
            this.activeVideoSlot.currentTimeSec = data.currentTimeSec;
            this.activeVideoSlot.tracker.addSample(data.speed);
            this.renderProgressLine();
          }
        }
      }).then(() => {
        if (this.isHalted) return;
        process.stdout.write('\n');
        console.log(`[SUCCESS - Slot V] Completed "${item.fileName}"`);
        this.completedVideoCount++;
        this.activeVideoSlot = null;
        this.checkAndFillSlots();
      }).catch((err) => {
        if (this.isHalted) return;
        process.stdout.write('\n');
        console.error(`================================================================================`);
        console.error(`[FAILURE - Slot V] Transcoding failed for "${item.fileName}":`);
        console.error(`${err.message}`);
        console.error(`================================================================================`);
        this.failedVideoCount++;
        this.activeVideoSlot = null;
        this.checkAndFillSlots(); // Continue processing remaining video queue items!
      });
    }

    // Check Audio-Only Queue Slots (Up to 4)
    for (let idx = 0; idx < CONCURRENCY_LIMITS.MAX_AUDIO_CONCURRENT; idx++) {
      if (!this.activeAudioSlots[idx] && this.audioOnlyQueue.length > 0) {
        const item = this.audioOnlyQueue.shift();
        const slotLabel = `A${idx + 1}`;

        this.activeAudioSlots[idx] = {
          item,
          percent: 0,
          speed: 1.0,
          currentTimeSec: 0,
          totalDuration: item.metadata.duration || 0,
          tracker: new RollingSpeedTracker(120000)
        };

        const completedCount = this.completedVideoCount + this.completedAudioCount + this.failedVideoCount + this.failedAudioCount + 1;
        this.logJobBanner(`[JOB START - Audio Slot ${slotLabel}] (${completedCount}/${this.totalJobsCount})`, item);

        spawnTranscodeJob(item, {
          slotLabel,
          qualityNum: this.qualityNum,
          onProgressUpdate: (data) => {
            if (this.activeAudioSlots[idx]) {
              this.activeAudioSlots[idx].percent = data.percent;
              this.activeAudioSlots[idx].speed = data.speed;
              this.activeAudioSlots[idx].currentTimeSec = data.currentTimeSec;
              this.activeAudioSlots[idx].tracker.addSample(data.speed);
              this.renderProgressLine();
            }
          }
        }).then(() => {
          if (this.isHalted) return;
          process.stdout.write('\n');
          console.log(`[SUCCESS - Slot ${slotLabel}] Completed "${item.fileName}"`);
          this.completedAudioCount++;
          this.activeAudioSlots[idx] = null;
          this.checkAndFillSlots();
        }).catch((err) => {
          if (this.isHalted) return;
          process.stdout.write('\n');
          console.error(`================================================================================`);
          console.error(`[FAILURE - Slot ${slotLabel}] Transcoding failed for "${item.fileName}":`);
          console.error(`${err.message}`);
          console.error(`================================================================================`);
          this.failedAudioCount++;
          this.activeAudioSlots[idx] = null;
          this.checkAndFillSlots(); // Continue processing remaining audio queue items!
        });
      }
    }

    // Check if all jobs complete (only when probing is finished too)
    const isVideoDone = !this.activeVideoSlot && this.videoQueue.length === 0;
    const isAudioDone = this.activeAudioSlots.every((s) => s === null) && this.audioOnlyQueue.length === 0;

    if (!this.isProbing && isVideoDone && isAudioDone && this.resolveCompletion) {
      process.stdout.write('\n');
      this.resolveCompletion({
        completedCount: this.completedVideoCount + this.completedAudioCount,
        failedCount: this.failedVideoCount + this.failedAudioCount
      });
    }
  }

  /**
   * Starts the batch scheduler and resolves when all queues finish.
   * @returns {Promise<Object>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
      this.checkAndFillSlots();
    });
  }
}
