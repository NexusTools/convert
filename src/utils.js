import path from 'path';
import readline from 'readline';
import { CANDIDATE_VIDEO_EXTENSIONS, IGNORED_VIDEO_EXTENSIONS, CANDIDATE_AUDIO_EXTENSIONS, IGNORED_AUDIO_EXTENSIONS } from './config.js';

/**
 * Checks if a given file path is a candidate video file for scanning.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isCandidateVideoFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CANDIDATE_VIDEO_EXTENSIONS.has(ext);
}

/**
 * Checks if a given file path is a candidate standalone audio file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isCandidateAudioFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CANDIDATE_AUDIO_EXTENSIONS.has(ext);
}

/**
 * Checks if a given file path is any candidate media file (video or audio).
 * @param {string} filePath
 * @returns {boolean}
 */
export function isCandidateMediaFile(filePath) {
  return isCandidateVideoFile(filePath) || isCandidateAudioFile(filePath);
}

/**
 * Checks if a given file path is a WebM file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isWebmFile(filePath) {
  return path.extname(filePath).toLowerCase() === '.webm';
}

/**
 * Checks if a given file path is an MKV file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isMkvFile(filePath) {
  return path.extname(filePath).toLowerCase() === '.mkv';
}

/**
 * Checks if a given file path is an Opus audio file that should be ignored.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isOpusFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IGNORED_AUDIO_EXTENSIONS.has(ext);
}

/**
 * Checks if a given file path is an MP4 file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isMp4File(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp4';
}

/**
 * Calculates optimal audio encoding bitrate in kbps for target codec ('opus' or 'eac3')
 * based on original codec efficiency, channel count, and original bitrate.
 *
 * Enforces strict optical audio (TOSLINK/S-PDIF) bandwidth cap of 640 kbps for EAC3.
 *
 * @param {string} origCodec Original audio codec name (e.g. 'flac', 'aac', 'ac3', 'dts', 'mp3').
 * @param {string} targetCodec Target audio encoder ('opus' or 'eac3').
 * @param {number} channels Number of audio channels.
 * @param {number} [origBitrateBps] Original bitrate in bits per second (if available).
 * @returns {number} Target bitrate in kbps.
 */
export function calculateAudioBitrateKbps(origCodec, targetCodec, channels, origBitrateBps) {
  const src = (origCodec || '').toLowerCase();
  const tgt = (targetCodec || 'opus').toLowerCase();
  const ch = channels || 2;
  const origKbps = origBitrateBps ? Math.round(origBitrateBps / 1000) : 0;

  const isLossless = ['flac', 'alac', 'wav', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'ape'].includes(src);

  // --- TARGET: OPUS ---
  if (tgt === 'opus' || tgt === 'libopus') {
    if (isLossless) {
      if (ch === 1) return 128;
      if (ch <= 2) return 256; // 256k high fidelity for FLAC/lossless stereo
      return 384;
    }

    let efficiencyFactor = 0.7; // default for AAC/m4a
    if (src === 'mp3') efficiencyFactor = 0.5;
    else if (src === 'wma') efficiencyFactor = 0.55;
    else if (src === 'ac3' || src === 'ec-3' || src === 'eac3') efficiencyFactor = 0.6;
    else if (src.includes('dts')) efficiencyFactor = 0.5;
    else if (src === 'vorbis') efficiencyFactor = 0.75;
    else if (src === 'aac') efficiencyFactor = 0.7;

    if (origKbps > 0) {
      const calculated = Math.round(origKbps * efficiencyFactor);
      if (ch === 1) return Math.min(128, Math.max(32, calculated));
      if (ch <= 2) return Math.min(256, Math.max(64, calculated));
      return Math.min(384, Math.max(160, calculated));
    }

    if (ch === 1) return 64;
    if (ch <= 2) return 128;
    return 256;
  }

  // --- TARGET: EAC3 ---
  // Absolute Optical Audio (TOSLINK / S-PDIF) Max Bandwidth Cap = 640 kbps
  const OPTICAL_MAX_EAC3_KBPS = 640;

  if (isLossless) {
    if (ch === 1) return 192;
    if (ch <= 2) return 320;
    return OPTICAL_MAX_EAC3_KBPS; // 640k max optical playback limit for 5.1 surround from FLAC/lossless
  }

  let efficiencyFactor = 0.8;
  if (src.includes('dts')) efficiencyFactor = 0.6;
  else if (src === 'mp3') efficiencyFactor = 0.75;
  else if (src === 'aac') efficiencyFactor = 0.9;
  else if (src === 'ac3' || src === 'ec-3' || src === 'eac3') efficiencyFactor = 0.85;

  if (origKbps > 0) {
    const calculated = Math.round(origKbps * efficiencyFactor);
    if (ch === 1) return Math.min(192, Math.max(64, calculated));
    if (ch <= 2) return Math.min(320, Math.max(128, calculated));
    // Cap at 640 kbps optical audio playback limit for multi-channel
    return Math.min(OPTICAL_MAX_EAC3_KBPS, Math.max(256, calculated));
  }

  // Fallbacks for EAC3 if original bitrate is unrecorded
  if (ch === 1) return 128;
  if (ch <= 2) return 256;
  return 448; // Standard 5.1 EAC3 bitrate (well below 640k optical cap)
}

/**
 * Alias for calculateAudioBitrateKbps targeting Opus.
 */
export function calculateOpusBitrateKbps(codec, channels, origBitrateBps) {
  return calculateAudioBitrateKbps(codec, 'opus', channels, origBitrateBps);
}

/**
 * Formats a duration in seconds into HH:MM:SS or MM:SS format.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const pad = (n) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * Formats byte size to human readable units (e.g. 1.25 GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Prompts the user on the console and resolves with their response string.
 * @param {string} question
 * @returns {Promise<string>}
 */
export function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
