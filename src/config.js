import fs from 'fs';
import path from 'path';

// Primary configured paths from Chocolatey installation
const CHOCO_FFMPEG_PATH = 'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffmpeg.exe';
const CHOCO_FFPROBE_PATH = 'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe';

/**
 * Resolves the available FFmpeg executable path.
 * Checks Chocolatey path first, falling back to system PATH if missing.
 */
export function getFfmpegPath() {
  if (fs.existsSync(CHOCO_FFMPEG_PATH)) {
    return CHOCO_FFMPEG_PATH;
  }
  return 'ffmpeg';
}

/**
 * Resolves the available FFprobe executable path.
 * Checks Chocolatey path first, falling back to system PATH if missing.
 */
export function getFfprobePath() {
  if (fs.existsSync(CHOCO_FFPROBE_PATH)) {
    return CHOCO_FFPROBE_PATH;
  }
  return 'ffprobe';
}

/**
 * File extensions that must be completely ignored during scanning.
 */
export const IGNORED_VIDEO_EXTENSIONS = new Set([]);
export const IGNORED_AUDIO_EXTENSIONS = new Set(['.opus']);

/**
 * Supported video file extensions for candidate scanning (including .webm, .mp4, .mkv, etc.).
 */
export const CANDIDATE_VIDEO_EXTENSIONS = new Set([
  '.webm',
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.flv',
  '.wmv',
  '.m4v',
  '.ts',
  '.mts',
  '.m2ts',
  '.3gp',
  '.vob',
  '.ogv',
  '.divx'
]);

/**
 * Supported standalone audio file extensions for candidate scanning (excluding .opus).
 */
export const CANDIDATE_AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.wav',
  '.flac',
  '.aac',
  '.ogg',
  '.wma',
  '.aiff',
  '.alac',
  '.ape'
]);

/**
 * Parallel Concurrency Limits.
 */
export const CONCURRENCY_LIMITS = {
  MAX_VIDEO_CONCURRENT: 1,
  MAX_AUDIO_CONCURRENT: 4
};

/**
 * Codec Efficiency Hierarchy Ranks (1 = Most Efficient, 5 = Least Efficient, 99 = Legacy/Unrecognized).
 */
export const CODEC_HIERARCHY_RANKS = {
  'av1': 1,
  'vp9': 2,
  'vp8': 3,
  'hevc': 4,
  'h265': 4,
  'h264': 5,
  'avc': 5,
  'avc1': 5
};

/**
 * Returns the efficiency rank for a video codec (1 to 5, or 99 for legacy/other).
 * @param {string} codecName
 * @returns {number}
 */
export function getCodecRank(codecName) {
  const norm = (codecName || '').toLowerCase();
  if (norm.includes('av1')) return 1;
  if (norm.includes('vp9')) return 2;
  if (norm.includes('vp8')) return 3;
  if (norm.includes('hevc') || norm.includes('265')) return 4;
  if (norm.includes('264') || norm.includes('avc')) return 5;
  return CODEC_HIERARCHY_RANKS[norm] || 99;
}

/**
 * Transcoding configuration defaults.
 */
export const TRANSCODE_CONFIG = {
  VIDEO: {
    CRF: 24
  },
  AUDIO: {
    MANY_CHANNELS_THRESHOLD: 3,
    MANY_CHANNELS_TARGET_CODEC: 'eac3',
    FEW_CHANNELS_TARGET_CODEC: 'opus', // ffmpeg encoder name 'libopus'
    FEW_CHANNELS_FFMPEG_ENCODER: 'libopus'
  }
};
