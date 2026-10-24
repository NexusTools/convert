import path from 'path';
import { CONCURRENCY_LIMITS, getFfmpegPath } from './config.js';
import { formatDuration } from './utils.js';
import { spawnTranscodeJob, killAllActiveJobs, buildFfmpegArgs } from './transcoder.js';

const FULL_HD_PIXELS = 1920 * 1080; // 2,073,600 pixels
const REFERENCE_FPS = 30;
const LOSSLESS_AUDIO_CODECS = new Set([
  'flac', 'alac', 'wav', 'ape', 'truehd', 'mlp',
  'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le'
]);
const IMAGE_SUB_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'vobsub', 'dvb_subtitle', 'xsub', 'arib_caption', 'pgssub', 'dvdsub'
]);

/**
 * Progressive rolling interval stages prior to reaching the full 15-minute window:
 * - Until 2 minutes is established: 2s, 5s, 15s, 30s, 45s
 * - From 2 minutes until 15 minutes is established: 2m, 5m, 8m, 12m
 * - Once 15 minutes is established: 15m (full window, no asterisk)
 */
export const SUB_TWO_MIN_INTERVALS_MS = [
  2 * 1000,   // 2 seconds
  5 * 1000,   // 5 seconds
  15 * 1000,  // 15 seconds
  30 * 1000,  // 30 seconds
  45 * 1000   // 45 seconds
];

export const SUB_FIFTEEN_MIN_INTERVALS_MS = [
  2 * 60 * 1000,  // 2 minutes
  5 * 60 * 1000,  // 5 minutes
  8 * 60 * 1000,  // 8 minutes
  12 * 60 * 1000  // 12 minutes
];

export const FULL_FIFTEEN_MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (900,000 ms)

/**
 * 15-second history bucket interval (15,000 ms) and maximum stored bucket count (60 buckets = 15 minutes).
 * Once >= 15 seconds of data has been fetched, the ETA updates once every 15 seconds using
 * the stored 15-second history buckets for the active interval stage.
 */
export const ETA_UPDATE_INTERVAL_MS = 15 * 1000; // 15 seconds
export const ETA_HISTORY_BUCKET_MS = 15 * 1000; // 15-second history buckets
export const MAX_ETA_HISTORY_BUCKETS = FULL_FIFTEEN_MIN_INTERVAL_MS / ETA_HISTORY_BUCKET_MS; // 60 buckets (15 minutes)

export const ETA_INTERVAL_LADDER_MS = [
  ...SUB_TWO_MIN_INTERVALS_MS,
  ...SUB_FIFTEEN_MIN_INTERVALS_MS,
  FULL_FIFTEEN_MIN_INTERVAL_MS
];

/**
 * Resolves the active rolling calculation interval window based on how much transcoding data
 * has been established so far:
 * - < 2m established: rolls through 2s, 5s, 15s, 30s, 45s
 * - 2m to < 15m established: rolls through 2m, 5m, 8m, 12m
 * - >= 15m established: uses full 15m window and marks isFull15MinEstablished = true
 *
 * @param {number} establishedMs Total milliseconds of transcoding data established so far.
 * @returns {{ activeWindowMs: number, isFull15MinEstablished: boolean }}
 */
export function resolveEtaIntervalState(establishedMs) {
  const validMs = Math.max(0, establishedMs || 0);

  if (validMs >= FULL_FIFTEEN_MIN_INTERVAL_MS) {
    return {
      activeWindowMs: FULL_FIFTEEN_MIN_INTERVAL_MS,
      isFull15MinEstablished: true
    };
  }

  let selectedWindowMs = SUB_TWO_MIN_INTERVALS_MS[0]; // 2 seconds default for immediate startup (< 2s)
  for (const stageMs of ETA_INTERVAL_LADDER_MS) {
    if (validMs >= stageMs) {
      selectedWindowMs = stageMs;
    } else {
      break;
    }
  }

  return {
    activeWindowMs: selectedWindowMs,
    isFull15MinEstablished: false
  };
}

/**
 * Formats seconds into a concise #d #h #m or #h#m or #m#s ETA string.
 * Adds days if total duration is 24 hours (86,400s) or more.
 * Appends an asterisk (*) when isPreliminary is true (indicating < 15 minutes of data established).
 *
 * @param {number} totalSeconds
 * @param {boolean} [isPreliminary=false]
 * @returns {string}
 */
export function formatEta(totalSeconds, isPreliminary = false) {
  if (!totalSeconds || isNaN(totalSeconds) || !isFinite(totalSeconds) || totalSeconds <= 0) return '0m00s';

  const rounded = Math.round(totalSeconds);
  const days = Math.floor(rounded / 86400);
  const hrs = Math.floor((rounded % 86400) / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = Math.floor(rounded % 60);

  const pad = (n) => String(n).padStart(2, '0');
  const suffix = isPreliminary ? '*' : '';

  if (days > 0) {
    return `${days}d ${pad(hrs)}h ${pad(mins)}m${suffix}`;
  }
  if (hrs > 0) {
    return `${pad(hrs)}h ${pad(mins)}m${suffix}`;
  }
  return `${mins}m${pad(secs)}s${suffix}`;
}

/**
 * Tracks transcoding throughput across a 15-minute (900,000 ms) maximum rolling window
 * by storing a rolling history of 15-second interval buckets (up to 60 buckets = 15 minutes),
 * plus fine-grained samples for the initial < 15s startup phase (immediate, 2s, 5s).
 *
 * Progressively steps through staged rolling intervals:
 * - Until 2m established: 2s, 5s, 15s (1 bucket), 30s (2 buckets), 45s (3 buckets)
 * - Until 15m established: 2m (8 buckets), 5m (20 buckets), 8m (32 buckets), 12m (48 buckets)
 * - At 15m+ established: full 15m rolling window (60 buckets of 15s)
 *
 * Combines:
 * 1. The difference in FFmpeg-reported percentage between updates over time (deltaPercent / deltaTimeSec)
 * 2. The validated FFmpeg playback speed (#x), cross-checked against deltaPercent / deltaTimeSec
 *    to detect and suppress fast-pass percentage spikes
 * 3. The complexity weight of the active transcode (length, resolution, SDR vs HDR, audio/subtitle tracks).
 */
export class RollingSpeedTracker {
  /**
   * @param {number} [windowMs=FULL_FIFTEEN_MIN_INTERVAL_MS] Maximum rolling window duration in ms (default: 15 minutes).
   */
  constructor(windowMs = FULL_FIFTEEN_MIN_INTERVAL_MS) {
    this.windowMs = Math.max(windowMs, FULL_FIFTEEN_MIN_INTERVAL_MS);
    this.bucketDurationMs = ETA_HISTORY_BUCKET_MS; // 15,000 ms (15 seconds)
    this.maxHistoryBuckets = Math.max(
      MAX_ETA_HISTORY_BUCKETS,
      Math.round(this.windowMs / this.bucketDurationMs)
    ); // 60 buckets = 15 minutes

    // Fine-grained delta samples (used for < 15s intervals: immediate, 2s, 5s)
    this.samples = []; // [{ timestamp, deltaPercent, deltaTimeSec, deltaWeight, deltaDuration, jobWeight, jobDuration, speed }]

    // Stored 15-second interval history buckets (up to 60 buckets = 15 minutes of history)
    this.historyBuckets = []; // [{ bucketIndex, startTime, endTime, durationMs, deltaWeight, deltaDuration, deltaPercent, deltaTimeSec, speed, weightRate }]
    this.currentBucket = null;
    this.totalBucketsCommitted = 0;
    this.lastCommittedBucketTimestamp = null;
    this.lastIngestedSampleEnd = null;
    this.lastAddSampleTimestamp = null;

    this.jobStartTime = Date.now();
    this.firstSampleTimestamp = null;
    this.lastTimestamp = null;
    this.lastPercent = 0;

    this.provisionalWeightRate = 0;
    this.provisionalSpeed = 0;
    this.provisionalPercentVelocity = 0;

    this.cumulativeDeltaWeight = 0;
    this.cumulativeDeltaDuration = 0;
    this.cumulativeDeltaPercent = 0;
    this.cumulativeDeltaTimeSec = 0;
  }

  /**
   * Resets per-job percentage anchors when a slot starts a new job, while preserving
   * stored 15-second history buckets and historical samples.
   * @param {number} [startTime=Date.now()]
   */
  resetJobAnchor(startTime = Date.now()) {
    this.jobStartTime = startTime;
    this.lastTimestamp = null;
    this.lastPercent = 0;
    this.provisionalWeightRate = 0;
    this.provisionalSpeed = 0;
    this.provisionalPercentVelocity = 0;
  }

  /**
   * Returns total milliseconds of transcoding data established by this tracker so far.
   * Once 15-second history buckets have been committed, includes the committed 15-second
   * history duration plus any in-progress bucket accumulation.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getEstablishedMs(now = Date.now()) {
    const committedHistoryMs = this.totalBucketsCommitted * this.bucketDurationMs;
    const currentBucketMs = this.currentBucket
      ? Math.min(this.bucketDurationMs - 1, Math.round(this.currentBucket.deltaTimeSec * 1000))
      : 0;
    const bucketBasedMs = committedHistoryMs + currentBucketMs;

    const cumulativeMs = this.cumulativeDeltaTimeSec * 1000;
    if (this.samples.length === 0) {
      if (this.lastTimestamp !== null && this.lastTimestamp > this.jobStartTime) {
        return Math.max(bucketBasedMs, cumulativeMs, this.lastTimestamp - this.jobStartTime);
      }
      return Math.max(bucketBasedMs, cumulativeMs);
    }
    const earliest = this.firstSampleTimestamp || this.samples[0].timestamp || now;
    const latest = this.samples[this.samples.length - 1].timestamp || now;
    const spanMs = Math.max(0, latest - earliest);
    return Math.max(bucketBasedMs, cumulativeMs, spanMs);
  }

  /**
   * Returns the currently active rolling interval stage ({ activeWindowMs, isFull15MinEstablished, establishedMs }).
   * @param {number} [now=Date.now()]
   * @returns {{ activeWindowMs: number, isFull15MinEstablished: boolean, establishedMs: number }}
   */
  getActiveIntervalState(now = Date.now()) {
    const establishedMs = this.getEstablishedMs(now);
    return {
      ...resolveEtaIntervalState(establishedMs),
      establishedMs
    };
  }

  /**
   * Returns the stored 15-second history buckets corresponding to the currently active
   * staged interval once >= 15 seconds of data has been fetched:
   * - 15s stage -> last 1 bucket (15s)
   * - 30s stage -> last 2 buckets (30s)
   * - 45s stage -> last 3 buckets (45s)
   * - 2m stage  -> last 8 buckets (120s)
   * - 5m stage  -> last 20 buckets (300s)
   * - 8m stage  -> last 32 buckets (480s)
   * - 12m stage -> last 48 buckets (720s)
   * - 15m stage -> last 60 buckets (900s)
   *
   * @param {number} [now=Date.now()]
   * @returns {Array<Object>}
   */
  getHistoryBucketsForActiveInterval(now = Date.now()) {
    if (this.historyBuckets.length === 0) return [];
    const { activeWindowMs } = this.getActiveIntervalState(now);
    if (activeWindowMs < this.bucketDurationMs) return [];

    const requiredBucketCount = Math.min(
      this.maxHistoryBuckets,
      Math.max(1, Math.round(activeWindowMs / this.bucketDurationMs))
    );
    return this.historyBuckets.slice(-requiredBucketCount);
  }

  /**
   * Internal helper that ingests a delta sample into the 15-second interval accumulator
   * and commits completed 15-second buckets into `this.historyBuckets` (capped at 60 buckets = 15 minutes).
   *
   * @param {Object} sample
   */
  _ingestSampleIntoHistoryBuckets(sample) {
    if (!sample || !(sample.deltaTimeSec > 0)) return;

    const sampleSpanMs = sample.deltaTimeSec * 1000;
    const sampleEnd = sample.timestamp || Date.now();
    const sampleStart = sampleEnd - sampleSpanMs;

    if (this.currentBucket === null) {
      this.currentBucket = {
        startTime: sampleStart,
        endTime: sampleStart + this.bucketDurationMs,
        deltaWeight: 0,
        deltaDuration: 0,
        deltaPercent: 0,
        deltaTimeSec: 0
      };
    } else if (this.lastIngestedSampleEnd !== null && sampleStart > this.lastIngestedSampleEnd + 1) {
      // Shift bucket end time across idle gaps between jobs so buckets always measure 15s of active transcoding
      const idleGapMs = sampleStart - this.lastIngestedSampleEnd;
      this.currentBucket.endTime += idleGapMs;
    }

    let cursorStart = sampleStart;

    // If a concurrent slot reports a sample whose start overlaps the just-committed bucket,
    // attribute that pre-boundary slice to the most recent committed bucket.
    if (cursorStart < this.currentBucket.startTime) {
      if (this.historyBuckets.length > 0) {
        const prevBucket = this.historyBuckets[this.historyBuckets.length - 1];
        const preOverlapEnd = Math.min(sampleEnd, this.currentBucket.startTime);
        const preOverlapMs = Math.max(0, preOverlapEnd - cursorStart);
        if (preOverlapMs > 0 && sampleSpanMs > 0) {
          const preFraction = Math.min(1, preOverlapMs / sampleSpanMs);
          prevBucket.deltaWeight += (sample.deltaWeight || 0) * preFraction;
          prevBucket.deltaDuration += (sample.deltaDuration || 0) * preFraction;
          prevBucket.deltaPercent += (sample.deltaPercent || 0) * preFraction;
          prevBucket.deltaTimeSec += sample.deltaTimeSec * preFraction;
          prevBucket.speed = prevBucket.deltaTimeSec > 0
            ? (prevBucket.deltaDuration / prevBucket.deltaTimeSec)
            : prevBucket.speed;
          prevBucket.weightRate = prevBucket.deltaTimeSec > 0
            ? (prevBucket.deltaWeight / prevBucket.deltaTimeSec)
            : prevBucket.weightRate;
        }
      }
      if (sampleEnd <= this.currentBucket.startTime) {
        this.lastIngestedSampleEnd = Math.max(this.lastIngestedSampleEnd || 0, sampleEnd);
        return;
      }
      cursorStart = this.currentBucket.startTime;
    }

    // Seal and commit 15-second history buckets whenever sampleEnd reaches/crosses currentBucket.endTime
    while (sampleEnd >= this.currentBucket.endTime - 1e-3) {
      const sliceMs = Math.max(0, this.currentBucket.endTime - cursorStart);
      if (sliceMs > 0 && sampleSpanMs > 0) {
        const fraction = Math.min(1, sliceMs / sampleSpanMs);
        this.currentBucket.deltaWeight += (sample.deltaWeight || 0) * fraction;
        this.currentBucket.deltaDuration += (sample.deltaDuration || 0) * fraction;
        this.currentBucket.deltaPercent += (sample.deltaPercent || 0) * fraction;
        this.currentBucket.deltaTimeSec += sample.deltaTimeSec * fraction;
      }

      if (this.currentBucket.deltaTimeSec > 0) {
        this.totalBucketsCommitted++;
        const committedBucket = {
          bucketIndex: this.totalBucketsCommitted,
          startTime: this.currentBucket.startTime,
          endTime: this.currentBucket.endTime,
          durationMs: this.bucketDurationMs,
          deltaWeight: this.currentBucket.deltaWeight,
          deltaDuration: this.currentBucket.deltaDuration,
          deltaPercent: this.currentBucket.deltaPercent,
          deltaTimeSec: this.currentBucket.deltaTimeSec,
          speed: this.currentBucket.deltaTimeSec > 0
            ? (this.currentBucket.deltaDuration / this.currentBucket.deltaTimeSec)
            : 0,
          weightRate: this.currentBucket.deltaTimeSec > 0
            ? (this.currentBucket.deltaWeight / this.currentBucket.deltaTimeSec)
            : 0
        };
        this.historyBuckets.push(committedBucket);
        if (this.historyBuckets.length > this.maxHistoryBuckets) {
          this.historyBuckets.shift();
        }
        this.lastCommittedBucketTimestamp = committedBucket.endTime;
      }

      cursorStart = this.currentBucket.endTime;
      this.currentBucket = {
        startTime: cursorStart,
        endTime: cursorStart + this.bucketDurationMs,
        deltaWeight: 0,
        deltaDuration: 0,
        deltaPercent: 0,
        deltaTimeSec: 0
      };

      if (Math.abs(sampleEnd - cursorStart) < 1e-3) {
        break;
      }
    }

    // Accumulate remaining slice (< 15s) into the new in-progress currentBucket
    if (sampleEnd > cursorStart + 1e-3 && sampleSpanMs > 0) {
      const remMs = sampleEnd - cursorStart;
      const fraction = Math.min(1, remMs / sampleSpanMs);
      this.currentBucket.deltaWeight += (sample.deltaWeight || 0) * fraction;
      this.currentBucket.deltaDuration += (sample.deltaDuration || 0) * fraction;
      this.currentBucket.deltaPercent += (sample.deltaPercent || 0) * fraction;
      this.currentBucket.deltaTimeSec += sample.deltaTimeSec * fraction;
    }

    this.lastIngestedSampleEnd = Math.max(this.lastIngestedSampleEnd || 0, sampleEnd);
  }

  /**
   * Records a progress update from FFmpeg by calculating the difference in reported percentage
   * over the elapsed wall-clock time since the previous update, cross-checked against the #x speed
   * and scaled by the job's complexity weight.
   *
   * @param {Object} params
   * @param {number} params.percent Current percentage (0 to 100) reported by FFmpeg.
   * @param {number} params.jobWeight Total complexity weight of the current transcode job.
   * @param {number} [params.totalDuration=0] Media duration in seconds of the current job.
   * @param {number} [params.speed=0] Validated FFmpeg speed multiplier (#x).
   * @param {number} [params.timestamp=Date.now()] Wall-clock timestamp in ms.
   * @returns {Object|null} The committed delta sample if an interval was committed, or null.
   */
  recordProgressUpdate({ percent, jobWeight, totalDuration = 0, speed = 0, timestamp = Date.now() }) {
    if (typeof percent !== 'number' || isNaN(percent) || percent < 0) return null;
    const clampedPercent = Math.min(100, Math.max(0, percent));
    const effectiveWeight = (jobWeight && jobWeight > 0) ? jobWeight : Math.max(1, totalDuration);
    const complexityPerSec = totalDuration > 0 ? (effectiveWeight / totalDuration) : 1.0;

    // First observation for this job:
    // If timestamp is within (50ms, 5000ms] after jobStartTime, treat jobStartTime (0%) as the initial anchor
    // so the very first tick [jobStartTime, timestamp] is recorded into the first 15-second bucket.
    // Otherwise (e.g. tick at t0 or synthetic timestamp base), anchor at `timestamp` and set provisional rates.
    if (this.lastTimestamp === null) {
      const elapsedSinceStartMs = timestamp - this.jobStartTime;
      if (clampedPercent > 0 && elapsedSinceStartMs >= 50 && elapsedSinceStartMs <= 5000) {
        this.lastTimestamp = this.jobStartTime;
        this.lastPercent = 0;
        if (this.firstSampleTimestamp === null) {
          this.firstSampleTimestamp = this.jobStartTime;
        }
      } else {
        if (this.firstSampleTimestamp === null) {
          this.firstSampleTimestamp = timestamp;
        }
        if (clampedPercent > 0) {
          this.lastTimestamp = timestamp;
          this.lastPercent = clampedPercent;

          const initDtSec = Math.max(0.1, elapsedSinceStartMs > 0 && elapsedSinceStartMs <= 30000 ? (elapsedSinceStartMs / 1000) : 0.5);
          const initFraction = clampedPercent / 100;
          const pctSpeed = totalDuration > 0 ? ((totalDuration * initFraction) / initDtSec) : (speed || 1.0);

          // Cross-check initial percentage jump against reported #x speed so a fast first pass cannot inflate rate
          const effectiveInitSpeed = (speed > 0 && pctSpeed > speed * 1.6)
            ? speed
            : (speed > 0 ? (0.65 * pctSpeed + 0.35 * speed) : pctSpeed);

          this.provisionalSpeed = Math.max(0.05, effectiveInitSpeed);
          this.provisionalWeightRate = this.provisionalSpeed * complexityPerSec;
          this.provisionalPercentVelocity = totalDuration > 0
            ? (this.provisionalSpeed / totalDuration) * 100
            : (clampedPercent / initDtSec);
        } else if (speed > 0) {
          this.lastTimestamp = timestamp;
          this.lastPercent = 0;
          this.provisionalSpeed = speed;
          this.provisionalWeightRate = speed * complexityPerSec;
        }
        return null;
      }
    }

    // Handle multi-pass percentage reset/decrease if one occurs without prior normalization
    if (clampedPercent < this.lastPercent - 1e-6) {
      this.lastTimestamp = timestamp;
      this.lastPercent = clampedPercent;
      return null;
    }

    const deltaTimeSec = (timestamp - this.lastTimestamp) / 1000;
    const rawDeltaPercent = Math.max(0, clampedPercent - this.lastPercent);

    // Avoid noisy sub-50ms timer jitter; accumulate until at least 50ms has elapsed
    if (deltaTimeSec < 0.05) {
      return null;
    }

    // If percentage has not changed yet on this progress line, wait up to 2.0s unless a 15s bucket boundary is reached
    const reachesBucketBoundary = this.currentBucket !== null && timestamp >= this.currentBucket.endTime - 1e-3;
    if (rawDeltaPercent <= 0 && deltaTimeSec < 2.0 && !reachesBucketBoundary) {
      return null;
    }

    // Calculate implied speed (#x) from the percentage delta over time: S_pct = (deltaPercent/100 * duration) / deltaTimeSec
    const deltaFractionFromPct = rawDeltaPercent / 100;
    const durationFromPct = totalDuration > 0
      ? (totalDuration * deltaFractionFromPct)
      : (speed > 0 ? speed * deltaTimeSec : effectiveWeight * deltaFractionFromPct);
    const impliedPctSpeed = durationFromPct / deltaTimeSec;

    // Cross-check implied percentage speed against #x speed to detect if percentage is increasing too fast
    let effectiveSpeed = impliedPctSpeed;
    if (speed > 0 && totalDuration > 0) {
      if (impliedPctSpeed > speed * 1.75) {
        // Percentage jumped faster than the encoder's #x speed allows: damp the spike down to #x speed
        effectiveSpeed = 0.25 * impliedPctSpeed + 0.75 * speed;
      } else if (rawDeltaPercent <= 0) {
        // Percentage temporarily paused while secondary pass catches up
        effectiveSpeed = 0.50 * impliedPctSpeed + 0.50 * speed;
      } else {
        // Normal operation: fuse percentage-delta rate (75%) with #x speed (25%)
        effectiveSpeed = 0.75 * impliedPctSpeed + 0.25 * speed;
      }
    }

    const effectiveDeltaDuration = effectiveSpeed * deltaTimeSec;
    const effectiveDeltaFraction = totalDuration > 0
      ? (effectiveDeltaDuration / totalDuration)
      : deltaFractionFromPct;
    const effectiveDeltaPercent = effectiveDeltaFraction * 100;
    const effectiveDeltaWeight = effectiveWeight * effectiveDeltaFraction;

    const sample = {
      timestamp,
      deltaPercent: effectiveDeltaPercent,
      deltaTimeSec,
      deltaWeight: effectiveDeltaWeight,
      deltaDuration: effectiveDeltaDuration,
      jobWeight: effectiveWeight,
      jobDuration: totalDuration,
      speed: effectiveSpeed
    };

    this.addDeltaSample(sample);

    this.lastTimestamp = timestamp;
    this.lastPercent = clampedPercent;

    return sample;
  }

  /**
   * Adds a pre-computed percentage/weight delta sample directly (used by slot and pool trackers),
   * recording it into both the < 15s fine-grained sample buffer and the 15-second history buckets.
   * @param {Object} sample
   */
  addDeltaSample(sample) {
    if (!sample || !(sample.deltaTimeSec > 0)) return;
    const now = sample.timestamp || Date.now();
    if (this.firstSampleTimestamp === null) {
      this.firstSampleTimestamp = now - (sample.deltaTimeSec * 1000);
    }
    this.samples.push(sample);

    if (sample.deltaWeight >= 0) {
      this.cumulativeDeltaWeight += sample.deltaWeight;
      this.cumulativeDeltaDuration += sample.deltaDuration || 0;
      this.cumulativeDeltaPercent += sample.deltaPercent || 0;
      this.cumulativeDeltaTimeSec += sample.deltaTimeSec;
    }

    this._ingestSampleIntoHistoryBuckets(sample);
    this.cleanOldSamples(now);
  }

  /**
   * Backwards-compatible method to add a raw speed sample.
   * @param {number} speed
   * @param {number} [timestamp=Date.now()]
   */
  addSample(speed, timestamp = Date.now()) {
    if (!speed || isNaN(speed) || speed <= 0) return;
    const dtSec = (this.lastAddSampleTimestamp !== null && timestamp > this.lastAddSampleTimestamp)
      ? Math.min(60, Math.max(0.05, (timestamp - this.lastAddSampleTimestamp) / 1000))
      : 1.0;
    this.lastAddSampleTimestamp = timestamp;

    this.addDeltaSample({
      timestamp,
      deltaPercent: 0,
      deltaTimeSec: dtSec,
      deltaWeight: speed * dtSec,
      deltaDuration: speed * dtSec,
      jobWeight: speed,
      jobDuration: speed,
      speed
    });
  }

  /**
   * Purges samples older than the 15-minute maximum rolling window cutoff.
   * Always retains at least the most recent 2 samples if no newer samples have arrived yet.
   * @param {number} [now=Date.now()]
   */
  cleanOldSamples(now = Date.now()) {
    if (this.samples.length <= 2) return;
    const latestSampleTime = this.samples[this.samples.length - 1].timestamp || now;
    const cutoff = latestSampleTime - this.windowMs;
    const filtered = this.samples.filter((s) => s.timestamp >= cutoff);
    if (filtered.length >= 2) {
      this.samples = filtered;
    } else {
      this.samples = this.samples.slice(-2);
    }
  }

  /**
   * Returns the samples belonging to the currently active staged interval window
   * (2s, 5s, 15s, 30s, 45s -> 2m, 5m, 8m, 12m -> 15m).
   *
   * @param {number} [now=Date.now()]
   * @returns {Array<Object>}
   */
  getSamplesForActiveInterval(now = Date.now()) {
    this.cleanOldSamples(now);
    if (this.samples.length === 0) return [];

    const { activeWindowMs } = this.getActiveIntervalState(now);
    const latestTimestamp = this.samples[this.samples.length - 1].timestamp || now;
    const intervalCutoff = latestTimestamp - activeWindowMs;

    const inWindow = this.samples.filter((s) => s.timestamp >= intervalCutoff);
    return inWindow.length > 0 ? inWindow : this.samples.slice(-1);
  }

  /**
   * Returns the complexity throughput rate (complexity weight units processed per wall-clock second)
   * calculated across the active staged interval:
   * - Once >= 15s of data has been fetched: computed strictly from the stored 15-second history buckets
   *   corresponding to the active step (15s=1, 30s=2, 45s=3, 2m=8, 5m=20, 8m=32, 12m=48, 15m=60 buckets).
   * - While < 15s of data has been fetched: computed from the 2s / 5s sample window or provisional rate.
   *
   * @param {number} [fallbackRate=0]
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getWeightRate(fallbackRate = 0, now = Date.now()) {
    const activeBuckets = this.getHistoryBucketsForActiveInterval(now);
    if (activeBuckets.length > 0) {
      let bucketDeltaWeight = 0;
      let bucketDeltaTime = 0;

      for (const b of activeBuckets) {
        if (b.deltaTimeSec > 0 && b.deltaWeight >= 0) {
          bucketDeltaWeight += b.deltaWeight;
          bucketDeltaTime += b.deltaTimeSec;
        }
      }

      if (bucketDeltaTime > 0 && bucketDeltaWeight > 0) {
        return bucketDeltaWeight / bucketDeltaTime;
      }
    }

    const activeSamples = this.getSamplesForActiveInterval(now);

    if (activeSamples.length > 0) {
      let intervalDeltaWeight = 0;
      let intervalDeltaTime = 0;

      for (const s of activeSamples) {
        if (s.deltaTimeSec > 0 && s.deltaWeight >= 0) {
          intervalDeltaWeight += s.deltaWeight;
          intervalDeltaTime += s.deltaTimeSec;
        }
      }

      if (intervalDeltaTime > 0 && intervalDeltaWeight > 0) {
        return intervalDeltaWeight / intervalDeltaTime;
      }
    }

    if (this.provisionalWeightRate > 0) {
      return this.provisionalWeightRate;
    }

    return fallbackRate;
  }

  /**
   * Returns the percentage velocity (% of current job completed per wall-clock second)
   * across the active staged interval (using 15s history buckets once >= 15s is established).
   * @param {number} [fallbackVelocity=0]
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getPercentVelocity(fallbackVelocity = 0, now = Date.now()) {
    const activeBuckets = this.getHistoryBucketsForActiveInterval(now);
    if (activeBuckets.length > 0) {
      let bucketDeltaPercent = 0;
      let bucketDeltaTime = 0;

      for (const b of activeBuckets) {
        if (b.deltaTimeSec > 0 && b.deltaPercent >= 0) {
          bucketDeltaPercent += b.deltaPercent;
          bucketDeltaTime += b.deltaTimeSec;
        }
      }

      if (bucketDeltaTime > 0 && bucketDeltaPercent > 0) {
        return bucketDeltaPercent / bucketDeltaTime;
      }
    }

    const activeSamples = this.getSamplesForActiveInterval(now);

    if (activeSamples.length > 0) {
      let intervalDeltaPercent = 0;
      let intervalDeltaTime = 0;

      for (const s of activeSamples) {
        if (s.deltaTimeSec > 0 && s.deltaPercent >= 0) {
          intervalDeltaPercent += s.deltaPercent;
          intervalDeltaTime += s.deltaTimeSec;
        }
      }

      if (intervalDeltaTime > 0 && intervalDeltaPercent > 0) {
        return intervalDeltaPercent / intervalDeltaTime;
      }
    }

    if (this.provisionalPercentVelocity > 0) {
      return this.provisionalPercentVelocity;
    }

    return fallbackVelocity;
  }

  /**
   * Returns moving average media playback speed multiplier (e.g. 3.8x) derived from
   * the percentage deltas and validated #x speeds across the active staged interval
   * (using 15s history buckets once >= 15s is established).
   *
   * @param {number} [fallbackSpeed=1.0]
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getAverageSpeed(fallbackSpeed = 1.0, now = Date.now()) {
    const activeBuckets = this.getHistoryBucketsForActiveInterval(now);
    if (activeBuckets.length > 0) {
      let bucketDuration = 0;
      let bucketTime = 0;

      for (const b of activeBuckets) {
        if (b.deltaTimeSec > 0 && typeof b.deltaDuration === 'number' && b.deltaDuration >= 0) {
          bucketDuration += b.deltaDuration;
          bucketTime += b.deltaTimeSec;
        }
      }

      if (bucketTime > 0 && bucketDuration > 0) {
        return bucketDuration / bucketTime;
      }
    }

    const activeSamples = this.getSamplesForActiveInterval(now);
    if (activeSamples.length === 0) {
      return this.provisionalSpeed > 0 ? this.provisionalSpeed : fallbackSpeed;
    }

    let intervalDuration = 0;
    let intervalTime = 0;

    for (const s of activeSamples) {
      if (s.deltaTimeSec > 0 && typeof s.deltaDuration === 'number' && s.deltaDuration >= 0) {
        intervalDuration += s.deltaDuration;
        intervalTime += s.deltaTimeSec;
      }
    }

    if (intervalTime > 0 && intervalDuration > 0) {
      return intervalDuration / intervalTime;
    }

    if (this.provisionalSpeed > 0) {
      return this.provisionalSpeed;
    }

    const sum = activeSamples.reduce((acc, s) => acc + (s.speed || 0), 0);
    return sum > 0 ? (sum / activeSamples.length) : fallbackSpeed;
  }
}

/**
 * Helper to compute the complexity weight of a single audio stream plan or metadata entry.
 * Factors in whether the track is transcoded vs copied, target codec (libopus vs eac3),
 * channel count / 5.1 pan downmix filtering, and lossless vs lossy source decoding.
 *
 * @param {Object} aStream Audio stream plan or metadata object.
 * @param {boolean} [isVideoJob=false] Whether this audio track is part of a GPU video transcode job.
 * @returns {number}
 */
function computeSingleAudioTrackComplexity(aStream, isVideoJob = false) {
  if (!aStream) return 0;
  const origCodec = (aStream.origCodec || aStream.codec || '').toLowerCase();
  const channels = Math.max(1, aStream.channels || 2);
  const needsTranscode = aStream.needsTranscode !== undefined
    ? Boolean(aStream.needsTranscode)
    : (channels >= 3 ? (origCodec !== 'eac3' && origCodec !== 'ec-3') : (origCodec !== 'opus'));

  if (!needsTranscode) {
    // Stream-copied audio track: packet demuxing + Matroska container interleaving overhead
    const copyBase = isVideoJob ? 0.015 : 0.08;
    return copyBase * Math.max(1, channels / 2);
  }

  const encoder = (aStream.encoder || (channels >= 3 ? 'eac3' : 'libopus')).toLowerCase();
  const isOpusTarget = encoder.includes('opus');
  const downmixTo5Point1 = Boolean(aStream.downmixTo5Point1 || channels > 6);

  // Target encoder base weight: libopus psychoacoustic encoding is more CPU-intensive than native eac3
  const encoderBase = isVideoJob
    ? (isOpusTarget ? 0.10 : 0.06)
    : (isOpusTarget ? 1.15 : 0.85);

  // Channel count & filter graph multiplier (>6ch triggers pan=5.1 downmix filter)
  let channelMultiplier = 1.0;
  if (downmixTo5Point1 || channels > 6) {
    channelMultiplier = 1.85;
  } else if (channels >= 3) {
    channelMultiplier = 1.45;
  } else if (channels === 1) {
    channelMultiplier = 0.75;
  }

  // Source audio decoder complexity multiplier (TrueHD, DTS-HD, FLAC, ALAC, PCM require heavier decoding)
  const isHeavySource = LOSSLESS_AUDIO_CODECS.has(origCodec) || origCodec.includes('dts') || origCodec.includes('pcm');
  const sourceDecodeMultiplier = isHeavySource ? 1.18 : 1.0;

  return encoderBase * channelMultiplier * sourceDecodeMultiplier;
}

/**
 * Calculates the per-second complexity weight multiplier of an Audio-Only transcode item.
 * Accounts for the number of audio tracks, per-track encoder/channel/downmix/source complexity,
 * stream-copied video track I/O (resolution & HDR vs SDR), and subtitle/attachment tracks.
 *
 * @param {Object} item
 * @returns {number} Complexity weight per media second
 */
export function getAudioTranscodeWeight(item) {
  if (!item) return 1.0;
  const metadata = item.metadata || {};
  const plan = item.plan || {};

  const audioPlans = (plan.audioStreamPlans && plan.audioStreamPlans.length > 0)
    ? plan.audioStreamPlans
    : (metadata.audioStreams || []);

  let audioWeightSum = 0;
  for (const aStream of audioPlans) {
    audioWeightSum += computeSingleAudioTrackComplexity(aStream, false);
  }
  if (audioWeightSum <= 0) {
    audioWeightSum = 1.0;
  }

  // If this audio-only job is remuxing/stream-copying a video stream (-c:v copy),
  // factor in the container I/O and packet interleaving cost of the video stream(s)
  let videoCopyOverhead = 0;
  if (metadata.videoStreamPresent && !plan.transcodeVideo) {
    const w = metadata.width || 0;
    const h = metadata.height || 0;
    const pixelRatio = (w > 0 && h > 0) ? ((w * h) / FULL_HD_PIXELS) : 1.0;
    const hdrCopyFactor = metadata.isHdr ? 1.30 : (metadata.is10Bit ? 1.15 : 1.0);
    const activeVidCount = Math.max(1, metadata.activeVideoStreamCount ?? metadata.videoStreamCount ?? 1);
    videoCopyOverhead = 0.18 * Math.max(0.25, pixelRatio) * hdrCopyFactor * activeVidCount;
  }

  // Subtitle tracks & attachments remuxing overhead
  const subtitlePlans = (plan.subtitleStreamPlans && plan.subtitleStreamPlans.length > 0)
    ? plan.subtitleStreamPlans
    : (metadata.subtitleStreams || []);

  let subtitleOverhead = 0;
  for (const sStream of subtitlePlans) {
    const sCodec = (sStream.origCodec || sStream.codec || '').toLowerCase();
    const isImageSub = Boolean(sStream.isImageSub || IMAGE_SUB_CODECS.has(sCodec) || sCodec.includes('pgs') || sCodec.includes('dvd') || sCodec.includes('vob'));
    const isConverted = sStream.encoder === 'srt' && sCodec !== 'srt' && sCodec !== 'subrip';
    subtitleOverhead += isImageSub ? 0.03 : (isConverted ? 0.02 : 0.015);
  }

  const attachmentOverhead = Math.min(20, metadata.attachmentCount || 0) * 0.002;

  const totalTracks = (metadata.videoStreamPresent ? Math.max(1, metadata.videoStreamCount || 1) : 0)
    + audioPlans.length
    + subtitlePlans.length;
  const muxInterleaveMultiplier = 1 + 0.012 * Math.max(0, totalTracks - 1);

  return Math.max(0.25, (audioWeightSum + videoCopyOverhead + subtitleOverhead + attachmentOverhead) * muxInterleaveMultiplier);
}

/**
 * Calculates total audio transcoding workload units for an audio-only queue item.
 * @param {Object} item
 * @returns {number}
 */
export function getAudioTranscodeWorkload(item) {
  if (!item || !item.metadata) return 0;
  const duration = item.metadata.duration || 0;
  if (duration <= 0) return 0;
  return duration * getAudioTranscodeWeight(item);
}

/**
 * Calculates the per-second complexity multiplier for a video transcode item based on:
 * - Resolution (normalized to 1080p with fixed pipeline floor + pixel/macroblock scaling)
 * - Frame rate (normalized to 30 fps)
 * - SDR vs HDR & 10-bit color space (8-bit SDR vs 10-bit SDR vs 10-bit HDR encode vs HDR-to-SDR conversion)
 * - Source video codec decoding complexity (AV1, VP9, HEVC, H.264, legacy)
 * - Total number and complexity of all tracks (video streams, transcoded/copied audio tracks, subtitles, attachments)
 *
 * @param {Object} item
 * @returns {number} Complexity weight per media second
 */
export function getVideoTranscodeComplexity(item) {
  if (!item || !item.metadata) return 1.0;
  const metadata = item.metadata;
  const plan = item.plan || {};

  // 1. Resolution Factor relative to 1080p Full HD (1920x1080 = 2,073,600 pixels)
  // 12% fixed per-frame pipeline dispatch/transfer floor + 88% pixel-proportional hardware encoding load
  const w = metadata.width || 0;
  const h = metadata.height || 0;
  const pixelCount = (w > 0 && h > 0) ? (w * h) : FULL_HD_PIXELS;
  const pixelRatio = pixelCount / FULL_HD_PIXELS;
  const resolutionFactor = Math.max(0.15, 0.12 + 0.88 * pixelRatio);

  // 2. Frame Rate Factor relative to 30 fps (85% frame-proportional + 15% time-bound container/audio baseline)
  const rawFps = metadata.fps || 0;
  const clampedFps = rawFps > 0 ? Math.min(240, Math.max(10, rawFps)) : REFERENCE_FPS;
  const fpsFactor = rawFps > 0 ? (0.15 + 0.85 * (clampedFps / REFERENCE_FPS)) : 1.0;

  // 3. SDR vs HDR & 10-Bit Color Space Factor
  // - Full 10-bit HDR hardware encode (p010le + Main10): 1.45x
  // - 10-bit HDR source downgraded to 8-bit SDR via software swscale (p010le -> nv12): 1.35x
  // - 10-bit SDR source (yuv420p10le): 1.25x
  // - 8-bit SDR source: 1.00x
  let hdrFactor = 1.0;
  if (metadata.isHdr) {
    hdrFactor = (plan.isHdr === false) ? 1.35 : 1.45;
  } else if (metadata.is10Bit) {
    hdrFactor = 1.25;
  }

  // 4. Source Video Codec Decoding Factor
  const srcVideoCodec = (metadata.videoCodec || '').toLowerCase();
  let sourceCodecFactor = 1.0;
  if (srcVideoCodec.includes('av1')) {
    sourceCodecFactor = 1.15;
  } else if (srcVideoCodec.includes('vp9') || srcVideoCodec.includes('hevc') || srcVideoCodec.includes('265')) {
    sourceCodecFactor = 1.08;
  } else if (srcVideoCodec.includes('vp8') || srcVideoCodec.includes('vc1') || srcVideoCodec.includes('wmv')) {
    sourceCodecFactor = 1.02;
  } else if (srcVideoCodec.includes('mpeg') || srcVideoCodec.includes('divx') || srcVideoCodec.includes('xvid') || srcVideoCodec.includes('mjpeg')) {
    sourceCodecFactor = 0.92;
  }

  const coreVideoComplexity = resolutionFactor * fpsFactor * hdrFactor * sourceCodecFactor;

  // 5. Multi-Track Complexity (Extra Video Streams + Audio Streams + Subtitle Streams + Attachments)
  const totalVideoStreams = Math.max(1, metadata.videoStreamCount || 1);
  const attachedPicStreams = Math.max(0, metadata.attachedPicCount || 0);
  const activeVideoStreams = metadata.activeVideoStreamCount !== undefined
    ? Math.max(1, metadata.activeVideoStreamCount)
    : Math.max(1, totalVideoStreams - attachedPicStreams);
  const extraActiveVideoStreams = Math.max(0, activeVideoStreams - 1);

  const extraVideoComplexity = (metadata.activeVideoStreamCount !== undefined)
    ? (extraActiveVideoStreams * 0.12 * resolutionFactor + attachedPicStreams * 0.01)
    : (extraActiveVideoStreams * 0.25 * resolutionFactor);

  // Audio tracks complexity inside the video transcode job
  const audioPlans = (plan.audioStreamPlans && plan.audioStreamPlans.length > 0)
    ? plan.audioStreamPlans
    : (metadata.audioStreams || []);

  let audioTracksComplexity = 0;
  for (const aStream of audioPlans) {
    audioTracksComplexity += computeSingleAudioTrackComplexity(aStream, true);
  }

  // Subtitle tracks complexity
  const subtitlePlans = (plan.subtitleStreamPlans && plan.subtitleStreamPlans.length > 0)
    ? plan.subtitleStreamPlans
    : (metadata.subtitleStreams || []);

  let subtitleTracksComplexity = 0;
  for (const sStream of subtitlePlans) {
    const sCodec = (sStream.origCodec || sStream.codec || '').toLowerCase();
    const isImageSub = Boolean(sStream.isImageSub || IMAGE_SUB_CODECS.has(sCodec) || sCodec.includes('pgs') || sCodec.includes('dvd') || sCodec.includes('vob'));
    const isConverted = sStream.encoder === 'srt' && sCodec !== 'srt' && sCodec !== 'subrip';
    subtitleTracksComplexity += isImageSub ? 0.015 : (isConverted ? 0.012 : 0.008);
  }

  const attachmentComplexity = Math.min(20, metadata.attachmentCount || 0) * 0.002;

  // Total track count Matroska muxer packet interleaving multiplier
  const totalTrackCount = totalVideoStreams + audioPlans.length + subtitlePlans.length;
  const muxInterleaveMultiplier = 1 + 0.012 * Math.max(0, totalTrackCount - 2);

  return (coreVideoComplexity + extraVideoComplexity + audioTracksComplexity + subtitleTracksComplexity + attachmentComplexity) * muxInterleaveMultiplier;
}

/**
 * Calculates total video transcoding complexity workload units for an item based on duration,
 * resolution (normalized to 1080p), frame rate, SDR vs HDR 10-bit color space, source codec,
 * and total number & complexity of video, audio, and subtitle tracks.
 *
 * @param {Object} item
 * @returns {number} Workload units
 */
export function getVideoTranscodeWorkload(item) {
  if (!item || !item.metadata) return 0;
  const duration = item.metadata.duration || 0;
  if (duration <= 0) return 0;
  return duration * getVideoTranscodeComplexity(item);
}

export class BatchScheduler {
  /**
   * @param {Object} [params]
   * @param {Array} [params.videoQueue]
   * @param {Array} [params.audioOnlyQueue]
   * @param {number} [params.totalVideoPoolDuration]
   * @param {number} [params.totalAudioOnlyPoolDuration]
   * @param {number} [params.qualityNum] User target video quality number (default: 24)
   * @param {Function} [params.onStateChange] Optional UI state listener callback
   */
  constructor({ videoQueue = [], audioOnlyQueue = [], totalVideoPoolDuration = 0, totalAudioOnlyPoolDuration = 0, qualityNum = 24, onStateChange = null } = {}) {
    this.videoQueue = [...videoQueue];
    this.audioOnlyQueue = [...audioOnlyQueue];

    this.qualityNum = qualityNum;
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;

    this.initialVideoCount = videoQueue.length;
    this.initialAudioCount = audioOnlyQueue.length;
    this.totalJobsCount = this.initialVideoCount + this.initialAudioCount;

    this.totalVideoPoolDuration = totalVideoPoolDuration;
    this.totalAudioOnlyPoolDuration = totalAudioOnlyPoolDuration;

    this.completedVideoCount = 0;
    this.completedAudioCount = 0;
    this.failedVideoCount = 0;
    this.failedAudioCount = 0;

    this.completedVideoWorkload = 0;
    this.completedAudioWorkload = 0;
    this.completedVideoItems = [];
    this.failedVideoItems = [];
    this.completedAudioItems = [];
    this.failedAudioItems = [];

    // Slot states and 15-minute staged interval rolling trackers
    this.activeVideoSlot = null; // { item, jobWeight, percent, speed, currentTimeSec, totalDuration, tracker }
    this.activeAudioSlots = new Array(CONCURRENCY_LIMITS.MAX_AUDIO_CONCURRENT).fill(null);

    // Cross-job pool-wide complexity throughput trackers over the full 15-minute window
    this.videoPoolTracker = new RollingSpeedTracker(FULL_FIFTEEN_MIN_INTERVAL_MS);
    this.audioPoolTracker = new RollingSpeedTracker(FULL_FIFTEEN_MIN_INTERVAL_MS);

    // 15-second cadence ETA cache state (once >= 15s of data is fetched, ETA updates once every 15s)
    this.lastEtaSnapshot = null;
    this.lastEtaBucketCommittedCount = 0;
    this.lastEtaSub15StageMs = -1;
    this.lastEtaUpdateTimestamp = null;
    this.lastEtaQueueSignature = '';

    // Probing state (supports adding multiple directories dynamically)
    this.isProbing = true;
    this.activeProbeTaskCount = 0;
    this.probingProcessed = 0;
    this.probingTotal = 0;
    this.probingPercent = 0;
    this.probingStatusText = 'PROBING: 0/0 (0.0%)';
    this.seenFilePaths = new Set();

    for (const item of [...videoQueue, ...audioOnlyQueue]) {
      if (item && item.filePath) {
        this.seenFilePaths.add(path.resolve(item.filePath).toLowerCase());
      }
    }

    this.isHalted = false;
    this.resolveCompletion = null;
    this.rejectCompletion = null;
  }

  /**
   * Notifies the optional UI listener whenever probing, queues, or slot progress changes.
   */
  notifyStateChange() {
    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange(this.getUiState());
      } catch {}
    }
  }

  /**
   * Registers a newly added directory probe task and its discovered candidate media file count.
   * @param {number} [candidateCount=0]
   */
  beginDirectoryProbe(candidateCount = 0) {
    this.activeProbeTaskCount++;
    this.isProbing = true;
    this.probingTotal += Math.max(0, candidateCount);
    const pct = this.probingTotal > 0
      ? ((this.probingProcessed / this.probingTotal) * 100).toFixed(1)
      : '0.0';
    this.probingPercent = parseFloat(pct) || 0;
    this.probingStatusText = `PROBING: ${this.probingProcessed}/${this.probingTotal} (${pct}%)`;
    this.renderProgressLine();
    this.notifyStateChange();
  }

  /**
   * Records that one candidate file has completed ffprobe across all active directory probe tasks.
   */
  recordProbedCandidate() {
    this.probingProcessed++;
    const pct = this.probingTotal > 0
      ? ((this.probingProcessed / this.probingTotal) * 100).toFixed(1)
      : '100.0';
    this.updateProbingStatus(this.probingProcessed, this.probingTotal, pct);
  }

  /**
   * Updates probing progress string to display in slot status line before probing finishes.
   * @param {number} processed
   * @param {number} total
   * @param {string} percentStr
   */
  updateProbingStatus(processed, total, percentStr) {
    this.isProbing = true;
    this.probingProcessed = processed;
    this.probingTotal = total;
    this.probingPercent = parseFloat(percentStr) || 0;
    this.probingStatusText = `PROBING: ${processed}/${total} (${percentStr}%)`;
    this.renderProgressLine();
    this.notifyStateChange();
  }

  /**
   * Replaces probing status with pool ETA once all active directory probe tasks are complete.
   */
  markProbingComplete() {
    if (this.activeProbeTaskCount > 0) {
      this.activeProbeTaskCount--;
    }
    if (this.activeProbeTaskCount === 0) {
      this.isProbing = false;
      this.probingPercent = 100;
      this.lastEtaSnapshot = null;
    }
    this.renderProgressLine();
    this.checkAndFillSlots();
    this.notifyStateChange();
  }

  /**
   * Dynamically enqueues a newly probed item and immediately starts transcoding if slots are idle.
   * Deduplicates file paths when additional directories are added.
   * @param {Object} fileItem
   */
  enqueueItem(fileItem) {
    if (!fileItem) return;
    if (fileItem.filePath) {
      const normalizedPath = path.resolve(fileItem.filePath).toLowerCase();
      if (this.seenFilePaths.has(normalizedPath)) {
        return;
      }
      this.seenFilePaths.add(normalizedPath);
    }

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
    this.notifyStateChange();
  }

  /**
   * Helper to infer the latest timestamp across all active and pool trackers.
   * @param {number} [explicitNow]
   * @returns {number}
   */
  _resolveCurrentTrackerTime(explicitNow) {
    if (typeof explicitNow === 'number' && !isNaN(explicitNow) && explicitNow > 0) {
      return explicitNow;
    }

    let latestSampleTime = 0;
    const checkTracker = (t) => {
      if (!t) return;
      if (t.samples && t.samples.length > 0) {
        const ts = t.samples[t.samples.length - 1].timestamp || 0;
        if (ts > latestSampleTime) latestSampleTime = ts;
      }
      if (t.lastTimestamp && t.lastTimestamp > latestSampleTime) {
        latestSampleTime = t.lastTimestamp;
      }
    };

    checkTracker(this.videoPoolTracker);
    checkTracker(this.audioPoolTracker);
    if (this.activeVideoSlot) checkTracker(this.activeVideoSlot.tracker);
    for (const slot of this.activeAudioSlots) {
      if (slot) checkTracker(slot.tracker);
    }

    return latestSampleTime > 0 ? latestSampleTime : Date.now();
  }

  /**
   * Calculates overall remaining video & audio pool weights and estimated time remaining (ETA)
   * across the staged rolling intervals:
   * - < 2m established: 2s, 5s, 15s, 30s, 45s (with * indicator)
   * - 2m to < 15m established: 2m, 5m, 8m, 12m (with * indicator)
   * - >= 15m established: full 15m window (no * indicator)
   *
   * Update Cadence:
   * - Before 15 seconds of data has been fetched (< 15s): updates at the initial, 2s, and 5s steps.
   * - Once 15 seconds or more of data has been fetched (>= 15s): updates strictly once every 15 seconds
   *   as each 15-second history bucket completes, using the stored 15-second history buckets for the
   *   active interval step (up to 60 buckets = 15 minutes).
   *
   * @param {number|Object} [optionsOrNow]
   * @returns {Object}
   */
  calculatePoolEta(optionsOrNow) {
    const force = typeof optionsOrNow === 'object' && optionsOrNow !== null
      ? Boolean(optionsOrNow.force)
      : false;
    const explicitNow = typeof optionsOrNow === 'number'
      ? optionsOrNow
      : (typeof optionsOrNow === 'object' && optionsOrNow !== null ? optionsOrNow.now : undefined);
    const now = this._resolveCurrentTrackerTime(explicitNow);

    // Inspect established duration and committed 15-second bucket count across trackers
    const videoPoolEstMs = this.videoPoolTracker.getEstablishedMs(now);
    const slotVideoEstMs = this.activeVideoSlot ? this.activeVideoSlot.tracker.getEstablishedMs(now) : 0;
    const preVideoEstMs = Math.max(videoPoolEstMs, slotVideoEstMs);

    let preAudioEstMs = this.audioPoolTracker.getEstablishedMs(now);
    let maxAudioSlotBuckets = 0;
    for (const slot of this.activeAudioSlots) {
      if (slot && slot.tracker) {
        preAudioEstMs = Math.max(preAudioEstMs, slot.tracker.getEstablishedMs(now));
        maxAudioSlotBuckets = Math.max(maxAudioSlotBuckets, slot.tracker.totalBucketsCommitted || 0);
      }
    }

    const currentEstablishedMs = Math.max(preVideoEstMs, preAudioEstMs);
    const maxBucketsCommitted = Math.max(
      this.videoPoolTracker.totalBucketsCommitted || 0,
      this.activeVideoSlot ? (this.activeVideoSlot.tracker.totalBucketsCommitted || 0) : 0,
      this.audioPoolTracker.totalBucketsCommitted || 0,
      maxAudioSlotBuckets
    );

    const hasActiveWork = Boolean(this.activeVideoSlot)
      || this.videoQueue.length > 0
      || this.activeAudioSlots.some((s) => s !== null)
      || this.audioOnlyQueue.length > 0;

    const queueSignature = `${this.videoQueue.length}:${this.audioOnlyQueue.length}:${Boolean(this.activeVideoSlot)}:${this.activeAudioSlots.filter(Boolean).length}`;
    const sub15StageMs = currentEstablishedMs >= 5000
      ? 5000
      : (currentEstablishedMs >= 2000 ? 2000 : 0);

    // Throttle ETA updates once >= 15 seconds of data has been fetched:
    // Only recalculate once every 15 seconds when a new 15-second history bucket is committed
    if (!force && hasActiveWork && this.lastEtaSnapshot !== null) {
      if (maxBucketsCommitted >= 1 || currentEstablishedMs >= ETA_UPDATE_INTERVAL_MS) {
        const newBucketCommitted = maxBucketsCommitted > this.lastEtaBucketCommittedCount;
        const transitionedTo15Sec = this.lastEtaBucketCommittedCount === 0 && maxBucketsCommitted === 0
          && (this.lastEtaSnapshot.establishedMs || 0) < ETA_UPDATE_INTERVAL_MS;
        const wallClock15SecElapsed = maxBucketsCommitted === 0
          && this.lastEtaUpdateTimestamp !== null
          && (now - this.lastEtaUpdateTimestamp) >= ETA_UPDATE_INTERVAL_MS;

        if (!newBucketCommitted && !transitionedTo15Sec && !wallClock15SecElapsed) {
          return this.lastEtaSnapshot;
        }
      } else if (sub15StageMs > 0 && sub15StageMs === this.lastEtaSub15StageMs && queueSignature === this.lastEtaQueueSignature) {
        // Between 2s..5s and 5s..15s, hold the 2s / 5s step ETA until the next step threshold is reached
        return this.lastEtaSnapshot;
      }
    }

    // =========================================================================
    // 1. Video Pool Remaining Complexity Weight & Staged-Interval ETA
    // =========================================================================
    const queuedVideoWorkload = this.videoQueue.reduce((acc, item) => acc + getVideoTranscodeWorkload(item), 0);
    let activeVideoRemainingWorkload = 0;

    const poolVideoWeightRate = this.videoPoolTracker.getWeightRate(0, now);
    const poolVideoIntervalState = this.videoPoolTracker.getActiveIntervalState(now);
    let videoEstablishedMs = poolVideoIntervalState.establishedMs;

    let activeSlotWeightRate = 0;

    if (this.activeVideoSlot) {
      const activeItem = this.activeVideoSlot.item;
      const totalItemWorkload = this.activeVideoSlot.jobWeight || getVideoTranscodeWorkload(activeItem);
      const clampedPercent = Math.min(100, Math.max(0, this.activeVideoSlot.percent || 0));
      const activeRemFraction = Math.max(0, 1 - (clampedPercent / 100));
      activeVideoRemainingWorkload = totalItemWorkload * activeRemFraction;

      const slotEstablishedMs = this.activeVideoSlot.tracker.getEstablishedMs(now);
      videoEstablishedMs = Math.max(videoEstablishedMs, slotEstablishedMs);

      const trackerWeightRate = this.activeVideoSlot.tracker.getWeightRate(0, now);
      const itemComplexity = getVideoTranscodeComplexity(activeItem);
      const avgSpeed = this.activeVideoSlot.tracker.getAverageSpeed(this.activeVideoSlot.speed || 0, now);
      const speedBasedWeightRate = avgSpeed > 0 ? (avgSpeed * itemComplexity) : 0;

      if (trackerWeightRate > 0 && speedBasedWeightRate > 0) {
        activeSlotWeightRate = 0.75 * trackerWeightRate + 0.25 * speedBasedWeightRate;
      } else {
        activeSlotWeightRate = trackerWeightRate > 0 ? trackerWeightRate : speedBasedWeightRate;
      }
    }

    const remainingVideoWorkload = activeVideoRemainingWorkload + queuedVideoWorkload;

    // Pool tracker integrates across the full active staged interval (2s..45s -> 2m..12m -> 15m)
    let videoRate = 3.5; // Immediate baseline fallback before first tick
    if (poolVideoWeightRate > 0 && activeSlotWeightRate > 0) {
      // Weight the staged pool interval rate primarily so 15s..15m history buckets govern smoothly
      videoRate = 0.70 * poolVideoWeightRate + 0.30 * activeSlotWeightRate;
    } else if (poolVideoWeightRate > 0) {
      videoRate = poolVideoWeightRate;
    } else if (activeSlotWeightRate > 0) {
      videoRate = activeSlotWeightRate;
    }

    const activeVideoEtaSec = activeVideoRemainingWorkload > 0
      ? (activeVideoRemainingWorkload / Math.max(0.05, videoRate))
      : 0;
    const queuedVideoEtaSec = queuedVideoWorkload > 0
      ? (queuedVideoWorkload / Math.max(0.05, videoRate)) + (this.videoQueue.length * 0.5)
      : 0;
    const videoEtaSec = activeVideoEtaSec + queuedVideoEtaSec;

    // =========================================================================
    // 2. Audio-Only Pool Remaining Complexity Weight & 4-Slot Parallel FIFO ETA
    // =========================================================================
    const queuedAudioWorkloads = this.audioOnlyQueue.map((item) => getAudioTranscodeWorkload(item));
    const queuedAudioWorkloadSum = queuedAudioWorkloads.reduce((acc, w) => acc + w, 0);

    let activeAudioRemainingWorkload = 0;
    const poolAudioSlotRate = this.audioPoolTracker.getWeightRate(0, now);
    const poolAudioIntervalState = this.audioPoolTracker.getActiveIntervalState(now);
    let audioEstablishedMs = poolAudioIntervalState.establishedMs;

    const measuredSlotRates = [];
    const perSlotRemainingSec = new Array(CONCURRENCY_LIMITS.MAX_AUDIO_CONCURRENT).fill(0);
    const activeSlotDetails = [];

    for (let idx = 0; idx < CONCURRENCY_LIMITS.MAX_AUDIO_CONCURRENT; idx++) {
      const slot = this.activeAudioSlots[idx];
      if (!slot) continue;

      const slotJobWeight = slot.jobWeight || getAudioTranscodeWorkload(slot.item);
      const clampedPercent = Math.min(100, Math.max(0, slot.percent || 0));
      const remFraction = Math.max(0, 1 - (clampedPercent / 100));
      const remWeight = slotJobWeight * remFraction;
      activeAudioRemainingWorkload += remWeight;

      const slotEstablishedMs = slot.tracker.getEstablishedMs(now);
      audioEstablishedMs = Math.max(audioEstablishedMs, slotEstablishedMs);

      const trackerWeightRate = slot.tracker.getWeightRate(0, now);
      const itemWeightFactor = getAudioTranscodeWeight(slot.item);
      const avgSpeed = slot.tracker.getAverageSpeed(slot.speed || 0, now);
      const speedBasedWeightRate = avgSpeed > 0 ? (avgSpeed * itemWeightFactor) : 0;

      let slotWeightRate = 0;
      if (trackerWeightRate > 0 && speedBasedWeightRate > 0) {
        slotWeightRate = 0.75 * trackerWeightRate + 0.25 * speedBasedWeightRate;
      } else {
        slotWeightRate = trackerWeightRate > 0 ? trackerWeightRate : speedBasedWeightRate;
      }

      if (slotWeightRate > 0) {
        measuredSlotRates.push(slotWeightRate);
      }

      activeSlotDetails.push({
        idx,
        remWeight,
        slotWeightRate,
        measuredSec: slot.tracker.cumulativeDeltaTimeSec
      });
    }

    const remainingWeightedAudioWork = activeAudioRemainingWorkload + queuedAudioWorkloadSum;

    let avgActiveSlotWeightRate = 0;
    if (measuredSlotRates.length > 0) {
      avgActiveSlotWeightRate = measuredSlotRates.reduce((a, b) => a + b, 0) / measuredSlotRates.length;
    }

    let calibratedPerSlotAudioRate = 45.0; // Immediate baseline per-slot audio weight units per second
    if (poolAudioSlotRate > 0 && avgActiveSlotWeightRate > 0) {
      calibratedPerSlotAudioRate = 0.70 * poolAudioSlotRate + 0.30 * avgActiveSlotWeightRate;
    } else if (poolAudioSlotRate > 0) {
      calibratedPerSlotAudioRate = poolAudioSlotRate;
    } else if (avgActiveSlotWeightRate > 0) {
      calibratedPerSlotAudioRate = avgActiveSlotWeightRate;
    }

    // Calculate each active audio slot's remaining completion time on its current item
    for (const detail of activeSlotDetails) {
      let effectiveSlotRate = calibratedPerSlotAudioRate;
      if (detail.slotWeightRate > 0) {
        effectiveSlotRate = 0.50 * detail.slotWeightRate + 0.50 * calibratedPerSlotAudioRate;
      }
      perSlotRemainingSec[detail.idx] = detail.remWeight > 0
        ? (detail.remWeight / Math.max(0.1, effectiveSlotRate))
        : 0;
    }

    // Simulate exact 4-slot parallel FIFO queue completion across all queued audio jobs
    const slotTimelineSec = [...perSlotRemainingSec];
    for (const jobWeight of queuedAudioWorkloads) {
      let earliestSlotIdx = 0;
      for (let i = 1; i < slotTimelineSec.length; i++) {
        if (slotTimelineSec[i] < slotTimelineSec[earliestSlotIdx]) {
          earliestSlotIdx = i;
        }
      }
      const estimatedJobSec = (jobWeight / Math.max(0.1, calibratedPerSlotAudioRate)) + 0.2;
      slotTimelineSec[earliestSlotIdx] += estimatedJobSec;
    }

    const audioEtaSec = remainingWeightedAudioWork > 0 ? Math.max(0, ...slotTimelineSec) : 0;

    // Overall ETA is the maximum of the parallel video queue ETA and audio queue ETA
    const overallEtaSec = Math.max(videoEtaSec, audioEtaSec);

    // Determine established data duration for the governing queue (or max established across active pools)
    const governingEstablishedMs = videoEtaSec >= audioEtaSec
      ? Math.max(videoEstablishedMs, audioEstablishedMs)
      : Math.max(audioEstablishedMs, videoEstablishedMs);
    const intervalState = resolveEtaIntervalState(governingEstablishedMs);
    const isPreliminaryEta = !intervalState.isFull15MinEstablished;

    const governingTracker = videoEtaSec >= audioEtaSec
      ? (this.videoPoolTracker.historyBuckets.length >= (this.activeVideoSlot?.tracker.historyBuckets.length || 0)
        ? this.videoPoolTracker
        : this.activeVideoSlot.tracker)
      : this.audioPoolTracker;
    const historyBucketCount = governingTracker ? governingTracker.historyBuckets.length : 0;
    const activeIntervalBucketCount = governingTracker
      ? governingTracker.getHistoryBucketsForActiveInterval(now).length
      : 0;

    const snapshot = {
      remainingVideoWorkload,
      remainingWeightedAudioWork,
      videoEtaSec,
      audioEtaSec,
      overallEtaSec,
      establishedMs: governingEstablishedMs,
      activeWindowMs: intervalState.activeWindowMs,
      isFull15MinEstablished: intervalState.isFull15MinEstablished,
      historyBucketCount,
      activeIntervalBucketCount,
      totalBucketsCommitted: maxBucketsCommitted,
      etaUpdateIntervalMs: ETA_UPDATE_INTERVAL_MS,
      lastEtaUpdateTimestamp: now,
      etaFormatted: formatEta(overallEtaSec, isPreliminaryEta)
    };

    this.lastEtaSnapshot = snapshot;
    this.lastEtaBucketCommittedCount = maxBucketsCommitted;
    this.lastEtaSub15StageMs = sub15StageMs;
    this.lastEtaUpdateTimestamp = now;
    this.lastEtaQueueSignature = queueSignature;

    return snapshot;
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
    if (process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(`\r\x1b[K${line}`);
    }
  }

  /**
   * Returns a complete snapshot of probing progress, overall progress bar percentage,
   * 15-minute staged ETA, and the active/queued/completed/failed items for both the
   * Video Queue and Audio-Only Queue for the NW.js UI.
   *
   * @returns {Object}
   */
  getUiState() {
    const eta = this.calculatePoolEta();

    const activeVideoDoneWork = this.activeVideoSlot
      ? (this.activeVideoSlot.jobWeight || getVideoTranscodeWorkload(this.activeVideoSlot.item))
        * (Math.min(100, Math.max(0, this.activeVideoSlot.percent || 0)) / 100)
      : 0;

    let activeAudioDoneWork = 0;
    for (const slot of this.activeAudioSlots) {
      if (slot) {
        const w = slot.jobWeight || getAudioTranscodeWorkload(slot.item);
        activeAudioDoneWork += w * (Math.min(100, Math.max(0, slot.percent || 0)) / 100);
      }
    }

    const doneWorkload = this.completedVideoWorkload + this.completedAudioWorkload + activeVideoDoneWork + activeAudioDoneWork;
    const remWorkload = (eta.remainingVideoWorkload || 0) + (eta.remainingWeightedAudioWork || 0);
    const totalWorkload = doneWorkload + remWorkload;

    let overallPercent = 0;
    if (totalWorkload > 0) {
      overallPercent = Math.min(100, Math.max(0, (doneWorkload / totalWorkload) * 100));
    } else if (!this.isProbing && this.totalJobsCount === 0) {
      overallPercent = 100;
    }

    return {
      isProbing: this.isProbing,
      probingProcessed: this.probingProcessed,
      probingTotal: this.probingTotal,
      probingPercent: this.probingPercent,
      probingStatusText: this.probingStatusText,
      overallPercent,
      totalJobsCount: this.totalJobsCount,
      completedVideoCount: this.completedVideoCount,
      completedAudioCount: this.completedAudioCount,
      failedVideoCount: this.failedVideoCount,
      failedAudioCount: this.failedAudioCount,
      initialVideoCount: this.initialVideoCount,
      initialAudioCount: this.initialAudioCount,
      eta,
      activeVideoSlot: this.activeVideoSlot ? {
        item: this.activeVideoSlot.item,
        jobWeight: this.activeVideoSlot.jobWeight,
        percent: this.activeVideoSlot.percent,
        speed: this.activeVideoSlot.tracker.getAverageSpeed(this.activeVideoSlot.speed),
        rawSpeed: this.activeVideoSlot.speed,
        currentTimeSec: this.activeVideoSlot.currentTimeSec,
        totalDuration: this.activeVideoSlot.totalDuration
      } : null,
      videoQueue: [...this.videoQueue],
      completedVideoItems: [...this.completedVideoItems],
      failedVideoItems: [...this.failedVideoItems],
      activeAudioSlots: this.activeAudioSlots.map((slot, idx) => slot ? {
        slotLabel: `A${idx + 1}`,
        item: slot.item,
        jobWeight: slot.jobWeight,
        percent: slot.percent,
        speed: slot.tracker.getAverageSpeed(slot.speed),
        rawSpeed: slot.speed,
        currentTimeSec: slot.currentTimeSec,
        totalDuration: slot.totalDuration
      } : null),
      audioOnlyQueue: [...this.audioOnlyQueue],
      completedAudioItems: [...this.completedAudioItems],
      failedAudioItems: [...this.failedAudioItems]
    };
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
      const jobWeight = getVideoTranscodeWorkload(item);
      const itemComplexity = getVideoTranscodeComplexity(item);
      const totalDuration = item.metadata.duration || 0;

      const calibratedVideoPoolRate = this.videoPoolTracker.getWeightRate(7.5);
      const expectedSpeed = Math.max(0.5, calibratedVideoPoolRate / Math.max(0.15, itemComplexity));

      this.activeVideoSlot = {
        item,
        jobWeight,
        percent: 0,
        speed: expectedSpeed,
        currentTimeSec: 0,
        totalDuration,
        tracker: new RollingSpeedTracker(FULL_FIFTEEN_MIN_INTERVAL_MS)
      };

      const completedCount = this.completedVideoCount + this.completedAudioCount + this.failedVideoCount + this.failedAudioCount + 1;
      this.logJobBanner(`[JOB START - Video Slot V] (${completedCount}/${this.totalJobsCount})`, item);
      this.renderProgressLine();
      this.notifyStateChange();

      spawnTranscodeJob(item, {
        slotLabel,
        qualityNum: this.qualityNum,
        expectedSpeed,
        onProgressUpdate: (data) => {
          if (this.activeVideoSlot) {
            this.activeVideoSlot.percent = data.percent;
            this.activeVideoSlot.speed = data.speed;
            this.activeVideoSlot.currentTimeSec = data.currentTimeSec;

            const deltaSample = this.activeVideoSlot.tracker.recordProgressUpdate({
              percent: data.percent,
              jobWeight: this.activeVideoSlot.jobWeight,
              totalDuration: this.activeVideoSlot.totalDuration,
              speed: data.speed,
              timestamp: data.timestamp || Date.now()
            });

            if (deltaSample) {
              this.videoPoolTracker.addDeltaSample(deltaSample);
            }

            this.renderProgressLine();
            this.notifyStateChange();
          }
        }
      }).then(() => {
        if (this.isHalted) return;
        process.stdout.write('\n');
        console.log(`[SUCCESS - Slot V] Completed "${item.fileName}"`);
        this.completedVideoCount++;
        this.completedVideoWorkload += jobWeight;
        this.completedVideoItems.push({
          item,
          jobWeight,
          status: 'completed',
          completedAt: Date.now()
        });
        this.activeVideoSlot = null;
        this.checkAndFillSlots();
        this.notifyStateChange();
      }).catch((err) => {
        if (this.isHalted) return;
        process.stdout.write('\n');
        console.error(`================================================================================`);
        console.error(`[FAILURE - Slot V] Transcoding failed for "${item.fileName}":`);
        console.error(`${err.message}`);
        console.error(`================================================================================`);
        this.failedVideoCount++;
        this.failedVideoItems.push({
          item,
          jobWeight,
          status: 'failed',
          error: err.message,
          completedAt: Date.now()
        });
        this.activeVideoSlot = null;
        this.checkAndFillSlots(); // Continue processing remaining video queue items!
        this.notifyStateChange();
      });
    }

    // Check Audio-Only Queue Slots (Up to 4)
    for (let idx = 0; idx < CONCURRENCY_LIMITS.MAX_AUDIO_CONCURRENT; idx++) {
      if (!this.activeAudioSlots[idx] && this.audioOnlyQueue.length > 0) {
        const item = this.audioOnlyQueue.shift();
        const slotLabel = `A${idx + 1}`;
        const jobWeight = getAudioTranscodeWorkload(item);
        const itemComplexity = getAudioTranscodeWeight(item);
        const totalDuration = item.metadata.duration || 0;

        const calibratedAudioPoolRate = this.audioPoolTracker.getWeightRate(55.0);
        const expectedSpeed = Math.max(2.0, calibratedAudioPoolRate / Math.max(0.25, itemComplexity));

        this.activeAudioSlots[idx] = {
          item,
          jobWeight,
          percent: 0,
          speed: expectedSpeed,
          currentTimeSec: 0,
          totalDuration,
          tracker: new RollingSpeedTracker(FULL_FIFTEEN_MIN_INTERVAL_MS)
        };

        const completedCount = this.completedVideoCount + this.completedAudioCount + this.failedVideoCount + this.failedAudioCount + 1;
        this.logJobBanner(`[JOB START - Audio Slot ${slotLabel}] (${completedCount}/${this.totalJobsCount})`, item);
        this.renderProgressLine();
        this.notifyStateChange();

        spawnTranscodeJob(item, {
          slotLabel,
          qualityNum: this.qualityNum,
          expectedSpeed,
          onProgressUpdate: (data) => {
            const slot = this.activeAudioSlots[idx];
            if (slot) {
              slot.percent = data.percent;
              slot.speed = data.speed;
              slot.currentTimeSec = data.currentTimeSec;

              const deltaSample = slot.tracker.recordProgressUpdate({
                percent: data.percent,
                jobWeight: slot.jobWeight,
                totalDuration: slot.totalDuration,
                speed: data.speed,
                timestamp: data.timestamp || Date.now()
              });

              if (deltaSample) {
                this.audioPoolTracker.addDeltaSample(deltaSample);
              }

              this.renderProgressLine();
              this.notifyStateChange();
            }
          }
        }).then(() => {
          if (this.isHalted) return;
          process.stdout.write('\n');
          console.log(`[SUCCESS - Slot ${slotLabel}] Completed "${item.fileName}"`);
          this.completedAudioCount++;
          this.completedAudioWorkload += jobWeight;
          this.completedAudioItems.push({
            item,
            jobWeight,
            slotLabel,
            status: 'completed',
            completedAt: Date.now()
          });
          this.activeAudioSlots[idx] = null;
          this.checkAndFillSlots();
          this.notifyStateChange();
        }).catch((err) => {
          if (this.isHalted) return;
          process.stdout.write('\n');
          console.error(`================================================================================`);
          console.error(`[FAILURE - Slot ${slotLabel}] Transcoding failed for "${item.fileName}":`);
          console.error(`${err.message}`);
          console.error(`================================================================================`);
          this.failedAudioCount++;
          this.failedAudioItems.push({
            item,
            jobWeight,
            slotLabel,
            status: 'failed',
            error: err.message,
            completedAt: Date.now()
          });
          this.activeAudioSlots[idx] = null;
          this.checkAndFillSlots(); // Continue processing remaining audio queue items!
          this.notifyStateChange();
        });
      }
    }

    // Check if all jobs complete (only when probing is finished too)
    const isVideoDone = !this.activeVideoSlot && this.videoQueue.length === 0;
    const isAudioDone = this.activeAudioSlots.every((s) => s === null) && this.audioOnlyQueue.length === 0;

    if (!this.isProbing && isVideoDone && isAudioDone && this.resolveCompletion) {
      process.stdout.write('\n');
      this.notifyStateChange();
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
