import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFfmpegPath } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Known GPU hardware video encoders mapped to their codec, rank, vendor, and encoder category.
 * Hierarchy Ranks: 1 = av1, 2 = vp9, 3 = vp8, 4 = hevc, 5 = h264
 */
export const KNOWN_HARDWARE_ENCODERS = {
  // --- AV1 (Rank 1) ---
  'av1_amf': { codec: 'av1', rank: 1, vendor: 'AMD AMF', type: 'amf' },
  'av1_nvenc': { codec: 'av1', rank: 1, vendor: 'NVIDIA NVENC', type: 'nvenc' },
  'av1_qsv': { codec: 'av1', rank: 1, vendor: 'Intel QuickSync', type: 'qsv' },
  'av1_vaapi': { codec: 'av1', rank: 1, vendor: 'VAAPI', type: 'vaapi' },
  'av1_vulkan': { codec: 'av1', rank: 1, vendor: 'Vulkan', type: 'vulkan' },

  // --- VP9 (Rank 2) ---
  'vp9_amf': { codec: 'vp9', rank: 2, vendor: 'AMD AMF', type: 'amf' },
  'vp9_nvenc': { codec: 'vp9', rank: 2, vendor: 'NVIDIA NVENC', type: 'nvenc' },
  'vp9_qsv': { codec: 'vp9', rank: 2, vendor: 'Intel QuickSync', type: 'qsv' },
  'vp9_vaapi': { codec: 'vp9', rank: 2, vendor: 'VAAPI', type: 'vaapi' },

  // --- VP8 (Rank 3) ---
  'vp8_qsv': { codec: 'vp8', rank: 3, vendor: 'Intel QuickSync', type: 'qsv' },
  'vp8_vaapi': { codec: 'vp8', rank: 3, vendor: 'VAAPI', type: 'vaapi' },

  // --- HEVC / H.265 (Rank 4) ---
  'hevc_amf': { codec: 'hevc', rank: 4, vendor: 'AMD AMF', type: 'amf' },
  'hevc_nvenc': { codec: 'hevc', rank: 4, vendor: 'NVIDIA NVENC', type: 'nvenc' },
  'hevc_qsv': { codec: 'hevc', rank: 4, vendor: 'Intel QuickSync', type: 'qsv' },
  'hevc_videotoolbox': { codec: 'hevc', rank: 4, vendor: 'Apple VideoToolbox', type: 'videotoolbox' },
  'hevc_vaapi': { codec: 'hevc', rank: 4, vendor: 'VAAPI', type: 'vaapi' },
  'hevc_vulkan': { codec: 'hevc', rank: 4, vendor: 'Vulkan', type: 'vulkan' },

  // --- H.264 / AVC (Rank 5) ---
  'h264_amf': { codec: 'h264', rank: 5, vendor: 'AMD AMF', type: 'amf' },
  'h264_nvenc': { codec: 'h264', rank: 5, vendor: 'NVIDIA NVENC', type: 'nvenc' },
  'h264_qsv': { codec: 'h264', rank: 5, vendor: 'Intel QuickSync', type: 'qsv' },
  'h264_videotoolbox': { codec: 'h264', rank: 5, vendor: 'Apple VideoToolbox', type: 'videotoolbox' },
  'h264_vaapi': { codec: 'h264', rank: 5, vendor: 'VAAPI', type: 'vaapi' },
  'h264_vulkan': { codec: 'h264', rank: 5, vendor: 'Vulkan', type: 'vulkan' }
};

/**
 * Runs ffmpeg -encoders to find all video hardware encoders present in the current FFmpeg build.
 * @returns {Promise<Array<Object>>} List of detected hardware encoder objects.
 */
export async function probeFfmpegEncoders() {
  const ffmpegPath = getFfmpegPath();
  try {
    const { stdout } = await execFileAsync(ffmpegPath, ['-encoders'], { maxBuffer: 10 * 1024 * 1024 });
    const lines = stdout.split('\n');
    const detected = [];

    for (const line of lines) {
      if (line.trim().startsWith('V')) { // Video encoder line
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const encoderName = parts[1];
          if (KNOWN_HARDWARE_ENCODERS[encoderName]) {
            detected.push({
              name: encoderName,
              ...KNOWN_HARDWARE_ENCODERS[encoderName]
            });
          }
        }
      }
    }

    return detected;
  } catch (err) {
    throw new Error(`Failed to probe FFmpeg encoders: ${err.message}`);
  }
}

/**
 * Executes a 0.2-second 4K (3840x2160) UHD synthetic test transcode to verify active GPU driver functionality.
 * Ensures HDR is only reported supported if it works at 4K resolution.
 *
 * @param {string} encoderName Name of the hardware encoder to test.
 * @param {boolean} testHdr10Bit Whether to test 10-bit HDR hardware encoding capabilities.
 * @returns {Promise<boolean>} True if the hardware test succeeded at 4K.
 */
export async function testHardwareEncoder(encoderName, testHdr10Bit = false) {
  const ffmpegPath = getFfmpegPath();
  const info = KNOWN_HARDWARE_ENCODERS[encoderName] || {};

  // Test at 4K resolution (3840x2160)
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=0.2:size=3840x2160:rate=30'
  ];

  if (testHdr10Bit) {
    args.push('-pix_fmt', 'p010le', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020');
    if (info.type === 'amf' || info.type === 'nvenc' || info.type === 'qsv') {
      args.push('-c:v', encoderName, '-profile:v', 'main10');
    } else {
      args.push('-c:v', encoderName);
    }
  } else {
    args.push('-pix_fmt', 'nv12', '-c:v', encoderName);
  }

  args.push('-f', 'null', '-');

  try {
    await execFileAsync(ffmpegPath, args, { timeout: 4000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Probes FFmpeg and selects the system's most efficient verified GPU hardware video encoder.
 * Checks SDR and 4K HDR (10-bit) driver support for all verified working hardware encoders.
 *
 * @returns {Promise<Object>} Selected hardware encoder specifications.
 */
export async function selectBestHardwareEncoder() {
  const detected = await probeFfmpegEncoders();

  if (detected.length === 0) {
    throw new Error('No GPU hardware video encoders (AMF, NVENC, QSV, VideoToolbox, VAAPI, Vulkan) were detected in FFmpeg.');
  }

  // Sort detected encoders by codec hierarchy rank (1 = av1, 2 = vp9, 3 = vp8, 4 = hevc, 5 = h264)
  detected.sort((a, b) => a.rank - b.rank);

  const verifiedEncoders = [];

  for (const candidate of detected) {
    const sdrPassed = await testHardwareEncoder(candidate.name, false);
    if (sdrPassed) {
      const hdrPassed = await testHardwareEncoder(candidate.name, true);
      verifiedEncoders.push({
        ...candidate,
        supportsSdr: true,
        supportsHdr: hdrPassed
      });
    }
  }

  if (verifiedEncoders.length === 0) {
    throw new Error('GPU hardware video encoders were reported by FFmpeg, but synthetic hardware execution tests failed on all encoders. Verify GPU hardware drivers.');
  }

  // Best encoder is the first item in verifiedEncoders (lowest rank number = most efficient)
  const best = verifiedEncoders[0];

  return {
    targetCodec: best.codec,
    targetEncoder: best.name,
    targetRank: best.rank,
    vendor: best.vendor,
    type: best.type,
    supportsSdr: best.supportsSdr,
    supportsHdr: best.supportsHdr,
    verifiedEncoders,
    allProbedEncoders: detected
  };
}
