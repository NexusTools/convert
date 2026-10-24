import { spawn, spawnSync } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { getFfmpegPath, TRANSCODE_CONFIG } from './config.js';
import { formatDuration } from './utils.js';

// Central process-wide active job registry (jobs remain registered until finished with code 0 or their unfinished output is deleted)
const activeJobs = new Set();
let processSignalHandlerRegistered = false;
let isShuttingDown = false;

/**
 * Synchronously terminates any remaining active FFmpeg child processes and deletes
 * their unfinished output files. Safe to call inside synchronous exit hooks such as
 * Node.js `process.on('exit')` and NW.js/DOM `beforeunload`/`unload`.
 */
export function killAllActiveJobsSync() {
  if (activeJobs.size === 0) return;

  const activeJobsArray = Array.from(activeJobs);

  // Step 1: Synchronously force-terminate any remaining FFmpeg processes so OS file handles are released
  for (const job of activeJobsArray) {
    const child = job.childProcess;
    if (child && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    if (process.platform === 'win32' && child && child.pid) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 2000
        });
      } catch {}
    }
  }

  // Step 2: Synchronously delete all unfinished output files
  for (const job of activeJobsArray) {
    const outPath = job.outputFilePath;
    if (outPath) {
      let deleted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (!fsSync.existsSync(outPath)) {
            deleted = true;
            break;
          }
          fsSync.unlinkSync(outPath);
          console.log(`[CLEANUP] Erased partial output file: "${outPath}"`);
          deleted = true;
          break;
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            deleted = true;
            break;
          }
          // Brief synchronous pause (up to ~40ms) to allow OS file handle release
          const waitUntil = Date.now() + 40;
          while (Date.now() < waitUntil) {
            // spin
          }
        }
      }
      if (!deleted && fsSync.existsSync(outPath)) {
        try {
          fsSync.unlinkSync(outPath);
          console.log(`[CLEANUP] Erased partial output file: "${outPath}"`);
        } catch (e) {
          console.warn(`[WARN] Could not erase partial output file "${outPath}": ${e.message}`);
        }
      }
    }
    activeJobs.delete(job);
  }
}

/**
 * Gracefully sends SIGTERM to all active FFmpeg child processes, awaits their full exit,
 * and then erases all incomplete partial output files while leaving original source files untouched.
 */
export async function killAllActiveJobs() {
  isShuttingDown = true;
  const activeJobsArray = Array.from(activeJobs);

  if (activeJobsArray.length === 0) return;

  // Step 1: Send SIGTERM to all active child processes and await their exit
  const killPromises = activeJobsArray.map((job) => {
    return new Promise((resolve) => {
      if (!job.childProcess || job.childProcess.killed || job.childProcess.exitCode !== null) {
        return resolve();
      }

      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      job.childProcess.once('close', done);
      job.childProcess.once('exit', done);

      try {
        job.childProcess.kill('SIGTERM');
      } catch (e) {
        done();
      }

      // Fallback: SIGKILL / taskkill if process hasn't exited within 1.5 seconds
      setTimeout(() => {
        if (!resolved && job.childProcess) {
          try {
            job.childProcess.kill('SIGKILL');
          } catch (e) {}
          if (process.platform === 'win32' && job.childProcess.pid) {
            try {
              spawnSync('taskkill', ['/PID', String(job.childProcess.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 1500
              });
            } catch (e) {}
          }
        }
        setTimeout(done, 150);
      }, 1500);
    });
  });

  await Promise.all(killPromises);

  // Step 2: Now that all FFmpeg processes are confirmed dead and file locks released, erase unfinished output files
  const unlinkPromises = activeJobsArray.map(async (job) => {
    if (job.outputFilePath) {
      let unlinked = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fs.unlink(job.outputFilePath);
          console.log(`[CLEANUP] Erased partial output file: "${job.outputFilePath}"`);
          unlinked = true;
          break;
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            unlinked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!unlinked && fsSync.existsSync(job.outputFilePath)) {
        try {
          fsSync.unlinkSync(job.outputFilePath);
          console.log(`[CLEANUP] Erased partial output file: "${job.outputFilePath}"`);
        } catch (e) {
          console.warn(`[WARN] Could not erase partial output file "${job.outputFilePath}": ${e.message}`);
        }
      }
    }
    activeJobs.delete(job);
  });

  await Promise.all(unlinkPromises);
}

/**
 * Registers global Node.js process signal & exit handlers (SIGINT, SIGTERM, SIGHUP, SIGBREAK, beforeExit, exit)
 * so unfinished outputs are always deleted when the Node.js process closes.
 */
export function setupGlobalSignalHandler() {
  if (processSignalHandlerRegistered) return;
  processSignalHandlerRegistered = true;

  const handleSignal = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    process.stdout.write('\n');
    console.log(`\n[CLEANUP] Received ${signal}. Terminating active FFmpeg processes and deleting unfinished outputs...`);

    try {
      await killAllActiveJobs();
    } catch {}
    killAllActiveJobsSync();

    console.log('[EXIT] Program terminated. Original media files left untouched.');
    process.exit(130);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGHUP', () => handleSignal('SIGHUP'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => handleSignal('SIGBREAK'));
  }

  process.on('beforeExit', async () => {
    if (activeJobs.size > 0) {
      isShuttingDown = true;
      try {
        await killAllActiveJobs();
      } catch {}
      killAllActiveJobsSync();
    }
  });

  // Synchronous guarantee when the Node.js process is exiting for any reason
  process.on('exit', () => {
    isShuttingDown = true;
    killAllActiveJobsSync();
  });
}

/**
 * Builds the FFmpeg command line arguments based on probe metadata and plan.
 * All video outputs (.mkv and .webm) use the Matroska container format (-f matroska).
 * All video streams are specified using stream-index specifiers (-c:v:0, -c:v:1) with no global -c:v copy.
 * Includes -stats_period 0.5 and bounded muxing queue thresholds so fast stream-copied tracks
 * cannot buffer 50MB ahead of encoded streams.
 *
 * @param {string} inputFilePath
 * @param {string} outputFilePath
 * @param {Object} plan
 * @param {number} [qualityNum=24]
 * @returns {string[]} FFmpeg argument list
 */
export function buildFfmpegArgs(inputFilePath, outputFilePath, plan, qualityNum = 24) {
  // Standalone Audio File Conversion to .opus
  if (plan.isAudioOnlyFile) {
    const args = [
      '-y',
      '-avoid_negative_ts', 'make_zero',
      '-i', inputFilePath,
      '-map', '0:a?'
    ];

    if (plan.audioStreamPlans && plan.audioStreamPlans.length > 0) {
      plan.audioStreamPlans.forEach((aPlan) => {
        args.push(`-c:a:${aPlan.audioIndex}`, 'libopus');
        if (aPlan.bitrateKbps && aPlan.bitrateKbps > 0) {
          args.push(`-b:a:${aPlan.audioIndex}`, `${aPlan.bitrateKbps}k`);
        }
      });
    } else {
      args.push('-c:a', 'libopus');
    }

    args.push('-stats_period', '0.5', '-progress', 'pipe:1', '-nostats');
    args.push(outputFilePath);
    return args;
  }

  // Video File Conversion (Outputs to .webm or .mkv using Matroska muxer -f matroska)
  const args = ['-y'];
  if (plan.transcodeVideo && plan.hwDeviceSpec) {
    args.push('-init_hw_device', plan.hwDeviceSpec, '-filter_hw_device', 'hw');
  }
  args.push(
    '-avoid_negative_ts', 'make_zero',
    '-i', inputFilePath,
    '-map', '0:v?',
    '-map', '0:a?',
    '-map', '0:s?',
    '-map', '0:t?' // Map font/data attachments natively in Matroska
  );

  // Video Stream Arguments (Stream-specific only - NEVER use global -c:v copy)
  const videoStreamCount = typeof plan.videoStreamCount === 'number'
    ? Math.max(1, plan.videoStreamCount)
    : 1;

  for (let vIdx = 0; vIdx < videoStreamCount; vIdx++) {
    if (vIdx === 0 && plan.transcodeVideo) {
      const targetEnc = plan.targetVideoCodec || TRANSCODE_CONFIG.VIDEO.TARGET_ENCODER || 'hevc_amf';
      const isHdr = Boolean(plan.isHdr);
      const useMain10 = plan.useMain10Profile !== false;

      if (plan.requiresHwUpload) {
        args.push('-vf', `format=${isHdr ? 'p010le' : 'nv12'},hwupload`);
      }

      if (targetEnc.includes('amf')) {
        args.push('-c:v:0', targetEnc, '-rc', 'cqp', '-qp_p', String(qualityNum), '-qp_i', String(qualityNum), '-quality', 'quality');
        if (isHdr) {
          if (!plan.requiresHwUpload) args.push('-pix_fmt', 'p010le');
          if (useMain10) args.push('-profile:v', 'main10');
        }
      } else if (targetEnc.includes('nvenc')) {
        args.push('-c:v:0', targetEnc, '-rc', 'constqp', '-qp', String(qualityNum), '-preset', 'p6');
        if (isHdr) {
          if (!plan.requiresHwUpload) args.push('-pix_fmt', 'p010le');
          if (useMain10) args.push('-profile:v', 'main10');
        }
      } else if (targetEnc.includes('qsv')) {
        args.push('-c:v:0', targetEnc, '-global_quality', String(qualityNum));
        if (isHdr) {
          if (!plan.requiresHwUpload) args.push('-pix_fmt', 'p010le');
          if (useMain10) args.push('-profile:v', 'main10');
        }
      } else if (targetEnc.includes('videotoolbox')) {
        args.push('-c:v:0', targetEnc, '-q:v', String(qualityNum));
        if (isHdr) {
          args.push('-pix_fmt', 'p010le', '-profile:v', 'main10');
        }
      } else {
        args.push('-c:v:0', targetEnc, '-qp', String(qualityNum));
        if (isHdr && !plan.requiresHwUpload) {
          args.push('-pix_fmt', 'p010le');
        }
      }
    } else {
      // Explicit stream-indexed copy for non-transcoded primary video stream 0:v:0 or secondary video streams (0:v:1)
      args.push(`-c:v:${vIdx}`, 'copy');
    }
  }

  // Audio Codec Arguments (Stream-specific or global fallback)
  if (plan.audioStreamPlans && plan.audioStreamPlans.length > 0) {
    plan.audioStreamPlans.forEach((aPlan) => {
      args.push(`-c:a:${aPlan.audioIndex}`, aPlan.encoder);
      if (aPlan.encoder === 'libopus' && aPlan.bitrateKbps && aPlan.bitrateKbps > 0) {
        args.push(`-b:a:${aPlan.audioIndex}`, `${aPlan.bitrateKbps}k`);
      }
      if (aPlan.downmixTo5Point1) {
        // Downmix audio tracks > 6 channels to 6 channels (5.1), keeping Front, Back, Center, Sub and dropping middle/side channels
        args.push(`-filter:a:${aPlan.audioIndex}`, 'pan=5.1|FL=c0|FR=c1|FC=c2|LFE=c3|BL=c4|BR=c5');
      }
    });
  } else {
    args.push('-c:a', 'copy');
  }

  // Subtitle Streams Arguments (Stream-specific)
  if (plan.subtitleStreamPlans && plan.subtitleStreamPlans.length > 0) {
    plan.subtitleStreamPlans.forEach((sPlan) => {
      args.push(`-c:s:${sPlan.subtitleIndex}`, sPlan.encoder);
    });
  } else {
    args.push('-c:s', 'copy');
  }

  // Bound muxing queue data threshold (4MB instead of 50MB default) to reduce fast-stream pre-buffering skew
  args.push('-max_muxing_queue_size', '1024', '-muxing_queue_data_threshold', '4194304');

  // Realtime progress reporting at 0.5s intervals via pipe
  args.push('-stats_period', '0.5', '-progress', 'pipe:1', '-nostats');

  // Matroska container format for all video outputs (.mkv and .webm)
  args.push('-f', 'matroska');

  // Output file directly
  args.push(outputFilePath);

  return args;
}

/**
 * Converts timestamp string (HH:MM:SS.microseconds) to total seconds.
 * Safely handles 'N/A' or negative pre-roll timestamps by returning 0.
 * @param {string} timeStr
 * @returns {number}
 */
export function parseTimeStringToSeconds(timeStr) {
  if (!timeStr) return 0;
  const trimmed = timeStr.trim();
  if (!trimmed || trimmed === 'N/A' || trimmed.startsWith('-')) return 0;
  const parts = trimmed.split(':');
  if (parts.length === 3) {
    const hrs = parseFloat(parts[0]);
    const mins = parseFloat(parts[1]);
    const secs = parseFloat(parts[2]);
    if (isNaN(hrs) || isNaN(mins) || isNaN(secs)) return 0;
    return Math.max(0, hrs * 3600 + mins * 60 + secs);
  }
  return 0;
}

/**
 * Normalizes multi-pass / multi-stream FFmpeg progress updates into a single monotonic percentage (0% to 100%)
 * and validated playback speed (#x).
 *
 * Handles two core FFmpeg behaviors:
 * 1. Fast auxiliary stream pass (e.g. subtitles or stream-copied audio/video racing to 90-100% at 100x-500x speed
 *    before resetting/dropping down to the slower video or audio encoding pass).
 * 2. Multi-pass / multi-track timestamp resets or decreases for a 2nd or 3rd pass, joining all passes into a single
 *    unified percentage weighted by inverse pass speed (time share) and cross-checked against #x speed and frame counts.
 */
export class MultiPassProgressNormalizer {
  /**
   * @param {Object} params
   * @param {Object} params.metadata Probed media metadata (duration, fps, nbFrames, etc.)
   * @param {Object} params.plan Transcode plan (transcodeVideo, audioStreamPlans, etc.)
   * @param {number} [params.expectedSpeed=0] Expected encoding speed (#x) based on job complexity weight.
   * @param {number} [params.startTime=Date.now()] Job spawn timestamp in ms.
   */
  constructor({ metadata = {}, plan = {}, expectedSpeed = 0, startTime = Date.now() } = {}) {
    this.metadata = metadata;
    this.plan = plan;
    this.totalDuration = metadata.duration || 0;
    this.videoFps = metadata.fps || 0;
    this.totalFrames = metadata.nbFrames || (this.totalDuration > 0 && this.videoFps > 0 ? Math.round(this.totalDuration * this.videoFps) : 0);
    this.transcodeVideo = Boolean(plan.transcodeVideo);

    // Expected physical speed (#x) for the primary workload based on complexity
    if (expectedSpeed > 0) {
      this.expectedSpeed = expectedSpeed;
    } else if (this.transcodeVideo) {
      const pixelRatio = (metadata.width > 0 && metadata.height > 0) ? ((metadata.width * metadata.height) / (1920 * 1080)) : 1.0;
      const hdrMult = metadata.isHdr ? 1.4 : 1.0;
      this.expectedSpeed = Math.max(1.0, 7.5 / (Math.max(0.25, pixelRatio) * hdrMult));
    } else {
      const audioTrackCount = Math.max(1, (plan.audioStreamPlans || []).filter((p) => p.needsTranscode).length);
      this.expectedSpeed = Math.max(5.0, 55.0 / audioTrackCount);
    }

    this.startTime = startTime;
    this.lastTimestamp = startTime;
    this.lastRawPercent = 0;
    this.maxRawPercentInPass = 0;
    this.maxAuxPercentSeen = 0;
    this.maxAuxSpeedSeen = 0;

    this.passNumber = 1;
    this.completedPassesUnifiedPercent = 0;
    this.currentPassStartRawPercent = 0;
    this.passPeakSpeeds = [];
    this.currentPassFastWeight = null;

    this.unifiedPercent = 0;
    this.validatedSpeed = this.expectedSpeed;
  }

  /**
   * Processes a single FFmpeg progress block and returns unified monotonic { percent, currentTimeSec, speed, passNumber }.
   *
   * @param {Object} raw
   * @param {number} raw.outTimeSec Parsed out_time in seconds.
   * @param {number} raw.frame Parsed video frame count.
   * @param {number} raw.fps Parsed video encoding FPS.
   * @param {number} raw.rawSpeedNum Parsed FFmpeg speed multiplier (#x).
   * @param {boolean} [raw.isEnd=false] True if progress=end.
   * @param {number} [raw.timestamp=Date.now()] Current wall-clock timestamp in ms.
   * @returns {Object} Normalized progress state
   */
  update({ outTimeSec = 0, frame = 0, fps = 0, rawSpeedNum = 1.0, isEnd = false, timestamp = Date.now() }) {
    if (isEnd) {
      this.unifiedPercent = 100;
      return {
        percent: 100,
        currentTimeSec: this.totalDuration,
        speed: this.validatedSpeed > 0 ? this.validatedSpeed : rawSpeedNum,
        passNumber: this.passNumber
      };
    }

    const elapsedTotalSec = Math.max(0.05, (timestamp - this.startTime) / 1000);
    const dtSec = Math.max(0.01, (timestamp - this.lastTimestamp) / 1000);

    const rawOutTimePercent = this.totalDuration > 0
      ? Math.min(100, Math.max(0, (outTimeSec / this.totalDuration) * 100))
      : 0;

    this.maxAuxPercentSeen = Math.max(this.maxAuxPercentSeen, rawOutTimePercent);

    // =========================================================================
    // PATH 1: Video Transcode with Known Frame Count & Video FPS
    // Cross-checks out_time & #x speed against actual encoded video frames
    // =========================================================================
    if (this.transcodeVideo && this.totalFrames > 0 && frame > 0) {
      const framePercent = Math.min(99.9, Math.max(0, (frame / this.totalFrames) * 100));
      const frameTimeSec = this.videoFps > 0
        ? (frame / this.videoFps)
        : (frame / this.totalFrames) * this.totalDuration;

      // True video encoding speed (#x) from FFmpeg's fps= or frameTimeSec / elapsedTotalSec
      const fpsBasedSpeed = (fps > 0 && this.videoFps > 0)
        ? (fps / this.videoFps)
        : (frameTimeSec / elapsedTotalSec);
      const cumulativeFrameSpeed = frameTimeSec / elapsedTotalSec;
      const trueVideoSpeed = fpsBasedSpeed > 0
        ? (0.70 * fpsBasedSpeed + 0.30 * cumulativeFrameSpeed)
        : Math.max(0.1, cumulativeFrameSpeed);

      // Detect if out_time has surged ahead of actual encoded video frames (Pass 1 fast stream buffering)
      const isOutTimeSurgingAhead = (rawOutTimePercent > framePercent + 4.0) || (rawSpeedNum > trueVideoSpeed * 1.6);
      if (isOutTimeSurgingAhead) {
        this.maxAuxSpeedSeen = Math.max(this.maxAuxSpeedSeen, rawSpeedNum);
      }

      if (rawOutTimePercent < this.lastRawPercent - 1.5) {
        // out_time just dropped/reset from the fast stream pass down to the video pass
        this.passNumber++;
      }

      // Weight the fast auxiliary stream pass by its inverse-speed time share (capped at 6% of total job)
      const fastStreamSpeed = Math.max(this.maxAuxSpeedSeen, rawSpeedNum, trueVideoSpeed * 15);
      const auxWeightShare = this.maxAuxPercentSeen > framePercent + 4.0
        ? Math.min(0.06, Math.max(0.01, trueVideoSpeed / (fastStreamSpeed + trueVideoSpeed)))
        : 0;

      const candidatePercent = isOutTimeSurgingAhead
        ? ((1 - auxWeightShare) * framePercent + auxWeightShare * this.maxAuxPercentSeen)
        : ((1 - auxWeightShare) * (0.65 * framePercent + 0.35 * rawOutTimePercent) + auxWeightShare * this.maxAuxPercentSeen);

      this.unifiedPercent = Math.min(99.9, Math.max(this.unifiedPercent, candidatePercent));
      this.validatedSpeed = Math.max(0.05, isOutTimeSurgingAhead ? trueVideoSpeed : (0.60 * trueVideoSpeed + 0.40 * rawSpeedNum));

      this.lastRawPercent = rawOutTimePercent;
      this.lastTimestamp = timestamp;

      return {
        percent: this.unifiedPercent,
        currentTimeSec: (this.unifiedPercent / 100) * this.totalDuration,
        speed: this.validatedSpeed,
        passNumber: this.passNumber
      };
    }

    // =========================================================================
    // PATH 2: Audio-Only / Multi-Track / Multi-Pass Progress Normalization
    // Uses #x speed & expected complexity speed to detect fast passes and join resets
    // =========================================================================
    const rawDeltaPercent = rawOutTimePercent - this.lastRawPercent;
    const impliedDeltaSpeed = (this.totalDuration > 0 && rawDeltaPercent > 0)
      ? ((rawDeltaPercent / 100) * this.totalDuration) / dtSec
      : 0;

    // Detect if raw percentage reset or decreased for a 2nd or 3rd pass
    if (rawOutTimePercent < this.lastRawPercent - 1.5) {
      this.passNumber++;
      this.completedPassesUnifiedPercent = this.unifiedPercent;
      this.currentPassStartRawPercent = rawOutTimePercent;
      this.maxRawPercentInPass = rawOutTimePercent;
      this.currentPassFastWeight = null;
    } else {
      this.maxRawPercentInPass = Math.max(this.maxRawPercentInPass, rawOutTimePercent);
    }

    const observedSurgeSpeed = Math.max(rawSpeedNum, impliedDeltaSpeed);
    const speedRatioVsExpected = this.expectedSpeed > 0 ? (observedSurgeSpeed / this.expectedSpeed) : 1.0;

    // Detect if current pass is increasing much faster than expected for this job's complexity
    // (e.g., Pass 1 stream-copy or fast track buffering at 250x while audio encode is 50x)
    if (this.passNumber === 1 && speedRatioVsExpected > 2.2 && rawOutTimePercent > 15) {
      // Inverse-speed time share of the fast pass relative to the expected main pass:
      // w_fast = S_expected / (S_fast + S_expected)
      const instantFastWeight = Math.min(0.45, Math.max(0.04, this.expectedSpeed / (observedSurgeSpeed + this.expectedSpeed)));
      this.currentPassFastWeight = this.currentPassFastWeight !== null
        ? Math.min(this.currentPassFastWeight, instantFastWeight)
        : instantFastWeight;
    }

    // Also detect when out_time is pinned near 95-100% while FFmpeg's cumulative speed is actively decaying
    // (meaning Pass 1 finished buffering to the end of the file, and Pass 2 is now encoding in the background!)
    const isPinnedNearEndCatchingUp = rawOutTimePercent >= 90 && Math.abs(rawDeltaPercent) < 0.5 && rawSpeedNum > 0;

    let candidatePercent = rawOutTimePercent;
    let effectiveSpeed = rawSpeedNum > 0 ? rawSpeedNum : this.expectedSpeed;

    if (this.passNumber === 1 && this.currentPassFastWeight !== null) {
      // Scale Pass 1's raw percentage by its true time weight share
      const pass1Contribution = rawOutTimePercent * this.currentPassFastWeight;

      if (isPinnedNearEndCatchingUp) {
        // While Pass 2 catches up in the background, FFmpeg's cumulative speed (out_time / elapsed)
        // decays toward the true Pass 2 encoding speed. Estimate Pass 2 progress from elapsed time * expectedSpeed:
        const estimatedMainPassSec = elapsedTotalSec * Math.min(rawSpeedNum, this.expectedSpeed);
        const estimatedMainPassPct = this.totalDuration > 0
          ? Math.min(99.5, (estimatedMainPassSec / this.totalDuration) * 100)
          : 0;
        candidatePercent = pass1Contribution + (1 - this.currentPassFastWeight) * estimatedMainPassPct;
        effectiveSpeed = Math.min(rawSpeedNum, Math.max(this.expectedSpeed, estimatedMainPassSec / elapsedTotalSec));
      } else {
        candidatePercent = pass1Contribution;
        effectiveSpeed = Math.min(rawSpeedNum, this.expectedSpeed * 1.35);
      }
    } else if (this.passNumber >= 2) {
      // Join Pass 2 / Pass 3 smoothly into the remaining [completedPassesUnifiedPercent, 100%] range
      const remainingRange = Math.max(1, 100 - this.completedPassesUnifiedPercent);
      const rawSpan = Math.max(1, 100 - this.currentPassStartRawPercent);
      const normalizedPassProgress = Math.min(1, Math.max(0, (rawOutTimePercent - this.currentPassStartRawPercent) / rawSpan));

      // If this subsequent pass is ALSO way faster than expected (e.g. Pass 2 of 3), reserve space for Pass 3
      const subPassWeight = speedRatioVsExpected > 2.5
        ? Math.min(0.6, Math.max(0.15, this.expectedSpeed / (observedSurgeSpeed + this.expectedSpeed)))
        : 1.0;

      candidatePercent = this.completedPassesUnifiedPercent + remainingRange * normalizedPassProgress * subPassWeight;
      effectiveSpeed = speedRatioVsExpected > 2.5 ? Math.min(rawSpeedNum, this.expectedSpeed * 1.5) : rawSpeedNum;
    }

    this.unifiedPercent = Math.min(99.9, Math.max(this.unifiedPercent, candidatePercent));
    this.validatedSpeed = Math.max(0.05, effectiveSpeed);

    this.lastRawPercent = rawOutTimePercent;
    this.lastTimestamp = timestamp;

    return {
      percent: this.unifiedPercent,
      currentTimeSec: (this.unifiedPercent / 100) * this.totalDuration,
      speed: this.validatedSpeed,
      passNumber: this.passNumber
    };
  }
}

/**
 * Spawns an individual FFmpeg transcode process and reports normalized multi-pass progress events to callback.
 *
 * @param {Object} fileItem Item containing filePath, metadata, and plan.
 * @param {Object} options Options { slotLabel, qualityNum, expectedSpeed, onProgressUpdate }.
 * @returns {Promise<void>}
 */
export async function spawnTranscodeJob(fileItem, options = {}) {
  const { filePath, metadata, plan } = fileItem;
  const { slotLabel = 'JOB', qualityNum = 24, expectedSpeed = 0, onProgressUpdate = () => {} } = options;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  const finalOutputPath = path.join(dir, `${baseName}${plan.targetExt || '.webm'}`);

  setupGlobalSignalHandler();

  const ffmpegPath = getFfmpegPath();
  const args = buildFfmpegArgs(filePath, finalOutputPath, plan, qualityNum);
  const fullCommand = `"${ffmpegPath}" ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;

  // Store fullCommand in plan object so job banner can display it
  plan.fullCommand = fullCommand;

  const jobState = {
    filePath,
    outputFilePath: finalOutputPath,
    childProcess: null,
    fullCommand
  };

  activeJobs.add(jobState);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    jobState.childProcess = child;

    let progressData = {};
    const totalDuration = metadata.duration || 0;
    const normalizer = new MultiPassProgressNormalizer({
      metadata,
      plan,
      expectedSpeed,
      startTime
    });

    const rl = readline.createInterface({
      input: child.stdout,
      terminal: false
    });

    rl.on('line', (line) => {
      const [key, value] = line.trim().split('=');
      if (key && value !== undefined) {
        progressData[key.trim()] = value.trim();
      }

      if (key === 'progress') {
        const now = Date.now();
        const isEnd = value && value.trim() === 'end';

        let outTimeSec = parseTimeStringToSeconds(progressData['out_time']);
        if (outTimeSec <= 0 && progressData['out_time_us'] && progressData['out_time_us'] !== 'N/A') {
          const us = parseInt(progressData['out_time_us'], 10);
          if (!isNaN(us) && us > 0) {
            outTimeSec = us / 1000000;
          }
        }

        const frame = parseInt(progressData['frame'] || '0', 10);
        const fps = parseFloat(progressData['fps'] || '0') || 0;

        let rawSpeedNum = 1.0;
        const rawSpeed = progressData['speed'] || '1x';
        const speedMatch = rawSpeed.match(/([\d.]+)x/);
        if (speedMatch) {
          rawSpeedNum = parseFloat(speedMatch[1]);
        }

        const normalized = normalizer.update({
          outTimeSec,
          frame,
          fps,
          rawSpeedNum,
          isEnd,
          timestamp: now
        });

        onProgressUpdate({
          slotLabel,
          filePath,
          percent: normalized.percent,
          currentTimeSec: normalized.currentTimeSec,
          totalDuration,
          frame,
          fps,
          speed: normalized.speed,
          rawSpeedNum,
          rawSpeed,
          passNumber: normalized.passNumber,
          timestamp: now
        });

        progressData = {};
      }
    });

    let stderrBuffer = '';
    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    child.on('error', (err) => {
      activeJobs.delete(jobState);
      reject(new Error(`Failed to start FFmpeg process: ${err.message}`));
    });

    child.on('close', async (code) => {
      if (isShuttingDown) {
        return; // Shutdown cleanup handler deletes unfinished output files and removes from activeJobs
      }

      if (code === 0) {
        activeJobs.delete(jobState);
        try {
          // Erase original source file
          await fs.unlink(filePath);
          resolve();
        } catch (fsErr) {
          reject(new Error(`Failed post-processing file cleanup for "${filePath}": ${fsErr.message}`));
        }
      } else {
        // Clean up incomplete output file before removing from activeJobs
        try {
          await fs.unlink(finalOutputPath);
          console.log(`[CLEANUP] Deleted incomplete output file: "${finalOutputPath}"`);
        } catch (e) {}
        activeJobs.delete(jobState);

        const err = new Error(`FFmpeg exited with error code ${code}.\nFFmpeg Error Output:\n${stderrBuffer.slice(-1500)}`);
        err.exitCode = code;
        reject(err);
      }
    });
  });
}
