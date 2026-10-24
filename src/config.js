import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { FFMPEG_CONFIG } from './ffmpegconfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT_DIR = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/**
 * Resolves the bundled or npm-installed FFmpeg executable path for the current operating system and architecture.
 * 1. Checks `FFMPEG_CONFIG.ffmpegRelativePath` (injected per-platform by @nexustools/nwjsreleasepackager in `src/ffmpegconfig.js`).
 * 2. Checks `bin/ffmpeg[.exe]` inside the packaged application root.
 * 3. Resolves from the `ffmpeg-static` npm package for the active `process.platform` and `process.arch`.
 */
export function getFfmpegPath() {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  if (FFMPEG_CONFIG && FFMPEG_CONFIG.ffmpegRelativePath) {
    const candidateFromRoot = path.resolve(APP_ROOT_DIR, FFMPEG_CONFIG.ffmpegRelativePath);
    if (fs.existsSync(candidateFromRoot)) {
      return candidateFromRoot;
    }
    const candidateFromCwd = path.resolve(process.cwd(), FFMPEG_CONFIG.ffmpegRelativePath);
    if (fs.existsSync(candidateFromCwd)) {
      return candidateFromCwd;
    }
  }

  const bundledBinCandidate = path.join(APP_ROOT_DIR, 'bin', exeName);
  if (fs.existsSync(bundledBinCandidate)) {
    return bundledBinCandidate;
  }

  const npmPlatformBin = path.join(
    APP_ROOT_DIR,
    'node_modules',
    'ffmpeg-static',
    'bin',
    process.platform,
    process.arch,
    exeName
  );
  if (fs.existsSync(npmPlatformBin)) {
    return npmPlatformBin;
  }

  try {
    const ffmpegStaticPath = require('ffmpeg-static');
    if (typeof ffmpegStaticPath === 'string' && fs.existsSync(ffmpegStaticPath)) {
      return ffmpegStaticPath;
    }
  } catch {}

  const directNpmCandidate = path.join(APP_ROOT_DIR, 'node_modules', 'ffmpeg-static', exeName);
  if (fs.existsSync(directNpmCandidate)) {
    return directNpmCandidate;
  }

  return exeName;
}

/**
 * Resolves the bundled or npm-installed FFprobe executable path for the current operating system and architecture.
 * 1. Checks `FFMPEG_CONFIG.ffprobeRelativePath` (injected per-platform by @nexustools/nwjsreleasepackager in `src/ffmpegconfig.js`).
 * 2. Checks `bin/ffprobe[.exe]` inside the packaged application root.
 * 3. Resolves from the `ffprobe-static` npm package for the active `process.platform` and `process.arch`.
 */
export function getFfprobePath() {
  const exeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

  if (FFMPEG_CONFIG && FFMPEG_CONFIG.ffprobeRelativePath) {
    const candidateFromRoot = path.resolve(APP_ROOT_DIR, FFMPEG_CONFIG.ffprobeRelativePath);
    if (fs.existsSync(candidateFromRoot)) {
      return candidateFromRoot;
    }
    const candidateFromCwd = path.resolve(process.cwd(), FFMPEG_CONFIG.ffprobeRelativePath);
    if (fs.existsSync(candidateFromCwd)) {
      return candidateFromCwd;
    }
  }

  const bundledBinCandidate = path.join(APP_ROOT_DIR, 'bin', exeName);
  if (fs.existsSync(bundledBinCandidate)) {
    return bundledBinCandidate;
  }

  const npmPlatformBin = path.join(
    APP_ROOT_DIR,
    'node_modules',
    'ffprobe-static',
    'bin',
    process.platform,
    process.arch,
    exeName
  );
  if (fs.existsSync(npmPlatformBin)) {
    return npmPlatformBin;
  }

  try {
    const ffprobeStatic = require('ffprobe-static');
    if (ffprobeStatic && typeof ffprobeStatic.path === 'string' && fs.existsSync(ffprobeStatic.path)) {
      return ffprobeStatic.path;
    }
  } catch {}

  return exeName;
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
