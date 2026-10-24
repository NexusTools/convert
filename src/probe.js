import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFfprobePath } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Parses an ffprobe rational frame rate string (e.g. "24000/1001" or "30/1") into a float FPS value.
 * @param {string} rateStr
 * @returns {number}
 */
function parseFrameRate(rateStr) {
  if (!rateStr || typeof rateStr !== 'string' || rateStr === '0/0') return 0;
  if (rateStr.includes('/')) {
    const [num, den] = rateStr.split('/').map(Number);
    if (num > 0 && den > 0) {
      const fps = num / den;
      return fps >= 1 && fps <= 240 ? fps : 0;
    }
    return 0;
  }
  const val = parseFloat(rateStr);
  return !isNaN(val) && val >= 1 && val <= 240 ? val : 0;
}

/**
 * Parses a tag duration string (e.g. "00:24:15.123000000") into seconds.
 * @param {string} durationTag
 * @returns {number}
 */
function parseTagDurationSeconds(durationTag) {
  if (!durationTag || typeof durationTag !== 'string') return 0;
  const parts = durationTag.trim().split(':');
  if (parts.length === 3) {
    const hrs = parseFloat(parts[0]);
    const mins = parseFloat(parts[1]);
    const secs = parseFloat(parts[2]);
    if (!isNaN(hrs) && !isNaN(mins) && !isNaN(secs)) {
      return Math.max(0, hrs * 3600 + mins * 60 + secs);
    }
  }
  return 0;
}

/**
 * Extracts stream frame count from ffprobe stream fields or Matroska NUMBER_OF_FRAMES tags.
 * @param {Object} stream
 * @param {number} duration
 * @param {number} fps
 * @returns {number}
 */
function extractStreamFrameCount(stream, duration, fps) {
  if (!stream) return 0;
  if (stream.nb_frames) {
    const n = parseInt(stream.nb_frames, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  const tags = stream.tags || {};
  for (const [k, v] of Object.entries(tags)) {
    if (k.toUpperCase().startsWith('NUMBER_OF_FRAMES') && v) {
      const n = parseInt(String(v), 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  if (duration > 0 && fps > 0) {
    return Math.round(duration * fps);
  }
  return 0;
}

/**
 * Probes a video/audio file using ffprobe and extracts media codec, HDR, resolution, frame count, and stream metadata.
 * @param {string} filePath Absolute or relative path to media file.
 * @returns {Promise<Object>} Metadata object detailing video, audio, HDR, resolution, and subtitle streams.
 */
export async function probeMediaFile(filePath) {
  const ffprobePath = getFfprobePath();
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ];

  try {
    const { stdout } = await execFileAsync(ffprobePath, args, { maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);

    const streams = parsed.streams || [];
    const format = parsed.format || {};

    const videoStreams = streams.filter((s) => s.codec_type === 'video');
    const attachedPicCount = videoStreams.filter((s) => s.disposition && s.disposition.attached_pic === 1).length;
    const realVideoStreams = videoStreams.filter((s) => !(s.disposition && s.disposition.attached_pic === 1));
    const videoStream = realVideoStreams[0] || videoStreams[0] || null;
    const videoStreamCount = videoStreams.length;
    const activeVideoStreamCount = realVideoStreams.length;

    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
    const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');
    const attachmentStreams = streams.filter((s) => s.codec_type === 'attachment' || s.codec_type === 'data');

    const videoCodec = videoStream ? (videoStream.codec_name || '').toLowerCase() : null;
    const width = videoStream && videoStream.width ? parseInt(videoStream.width, 10) : 0;
    const height = videoStream && videoStream.height ? parseInt(videoStream.height, 10) : 0;
    const fps = videoStream
      ? (parseFrameRate(videoStream.avg_frame_rate) || parseFrameRate(videoStream.r_frame_rate) || 0)
      : 0;
    const videoBitrate = (videoStream && videoStream.bit_rate)
      ? parseInt(videoStream.bit_rate, 10)
      : (format.bit_rate ? parseInt(format.bit_rate, 10) : 0);

    // HDR Color Metadata Detection
    const pixFmt = videoStream ? (videoStream.pix_fmt || '').toLowerCase() : '';
    const bitsPerSample = videoStream ? String(videoStream.bits_per_raw_sample || videoStream.bits_per_sample || '') : '';
    const colorTransfer = videoStream ? (videoStream.color_transfer || '').toLowerCase() : '';
    const colorSpace = videoStream ? (videoStream.color_space || '').toLowerCase() : '';
    const colorPrimaries = videoStream ? (videoStream.color_primaries || '').toLowerCase() : '';

    const is10Bit = pixFmt.includes('p010') || pixFmt.includes('10le') || pixFmt.includes('10be') || bitsPerSample === '10';
    const isHdrTransfer = colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67';
    const isHdrSpace = colorSpace === 'bt2020nc' || colorSpace === 'bt2020c' || colorSpace === 'bt2020';

    const isHdr = Boolean(videoStream) && (is10Bit || isHdrTransfer || isHdrSpace);

    const videoStreamsDetail = videoStreams.map((s, idx) => ({
      streamIndex: s.index,
      videoIndex: idx,
      codec: (s.codec_name || '').toLowerCase(),
      width: s.width ? parseInt(s.width, 10) : 0,
      height: s.height ? parseInt(s.height, 10) : 0,
      isAttachedPic: Boolean(s.disposition && s.disposition.attached_pic === 1)
    }));

    const audioStreamsDetail = audioStreams.map((s, idx) => ({
      streamIndex: s.index,
      audioIndex: idx,
      codec: (s.codec_name || '').toLowerCase(),
      channels: typeof s.channels === 'number' ? s.channels : 0,
      bitrate: s.bit_rate ? parseInt(s.bit_rate, 10) : (format.bit_rate ? parseInt(format.bit_rate, 10) : 0)
    }));

    const subtitleStreamsDetail = subtitleStreams.map((s, idx) => ({
      streamIndex: s.index,
      subtitleIndex: idx,
      codec: (s.codec_name || '').toLowerCase()
    }));

    // Primary audio info
    const primaryAudio = audioStreamsDetail[0] || null;
    const audioCodec = primaryAudio ? primaryAudio.codec : null;
    const audioChannels = primaryAudio ? primaryAudio.channels : 0;

    // Resolve authoritative media duration across container format and primary streams
    const candidateDurations = [];
    if (format.duration) {
      const d = parseFloat(format.duration);
      if (!isNaN(d) && d > 0) candidateDurations.push(d);
    }
    if (videoStream) {
      if (videoStream.duration) {
        const d = parseFloat(videoStream.duration);
        if (!isNaN(d) && d > 0) candidateDurations.push(d);
      }
      if (videoStream.tags) {
        for (const [k, v] of Object.entries(videoStream.tags)) {
          if (k.toUpperCase().startsWith('DURATION')) {
            const d = parseTagDurationSeconds(String(v));
            if (d > 0) candidateDurations.push(d);
          }
        }
      }
    }
    for (const aStream of audioStreams) {
      if (aStream.duration) {
        const d = parseFloat(aStream.duration);
        if (!isNaN(d) && d > 0) candidateDurations.push(d);
      }
    }

    const duration = candidateDurations.length > 0 ? Math.max(...candidateDurations) : 0;
    const nbFrames = extractStreamFrameCount(videoStream, duration, fps);

    return {
      filePath,
      formatName: format.format_name || '',
      duration,
      nbFrames,
      videoStreamPresent: Boolean(videoStream),
      videoStreamCount,
      activeVideoStreamCount,
      attachedPicCount,
      videoCodec,
      width,
      height,
      fps,
      videoBitrate,
      videoStreams: videoStreamsDetail,
      pixFmt,
      bitsPerSample,
      colorTransfer,
      colorSpace,
      colorPrimaries,
      is10Bit,
      isHdr,
      audioStreamPresent: audioStreamsDetail.length > 0,
      audioCodec,
      audioChannels,
      audioStreams: audioStreamsDetail,
      subtitleStreams: subtitleStreamsDetail,
      subtitleCount: subtitleStreamsDetail.length,
      hasAttachments: attachmentStreams.length > 0,
      attachmentCount: attachmentStreams.length
    };
  } catch (error) {
    throw new Error(`Failed to probe media file "${filePath}": ${error.message}`);
  }
}
