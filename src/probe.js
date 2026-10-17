import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFfprobePath } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Probes a video/audio file using ffprobe and extracts media codec, HDR, resolution, and stream metadata.
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
    const videoStream = videoStreams[0] || null;
    const videoStreamCount = videoStreams.length;

    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
    const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');
    const attachmentStreams = streams.filter((s) => s.codec_type === 'attachment' || s.codec_type === 'data');

    const videoCodec = videoStream ? (videoStream.codec_name || '').toLowerCase() : null;
    const width = videoStream && videoStream.width ? parseInt(videoStream.width, 10) : 0;
    const height = videoStream && videoStream.height ? parseInt(videoStream.height, 10) : 0;

    // HDR Color Metadata Detection
    const pixFmt = videoStream ? (videoStream.pix_fmt || '').toLowerCase() : '';
    const bitsPerSample = videoStream ? String(videoStream.bits_per_raw_sample || videoStream.bits_per_sample || '') : '';
    const colorTransfer = videoStream ? (videoStream.color_transfer || '').toLowerCase() : '';
    const colorSpace = videoStream ? (videoStream.color_space || '').toLowerCase() : '';
    const colorPrimaries = videoStream ? (videoStream.color_primaries || '').toLowerCase() : '';

    const is10Bit = pixFmt.includes('p010') || pixFmt.includes('10le') || bitsPerSample === '10';
    const isHdrTransfer = colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67';
    const isHdrSpace = colorSpace === 'bt2020nc' || colorSpace === 'bt2020c' || colorSpace === 'bt2020';

    const isHdr = Boolean(videoStream) && (is10Bit || isHdrTransfer || isHdrSpace);

    const videoStreamsDetail = videoStreams.map((s, idx) => ({
      streamIndex: s.index,
      videoIndex: idx,
      codec: (s.codec_name || '').toLowerCase(),
      width: s.width ? parseInt(s.width, 10) : 0,
      height: s.height ? parseInt(s.height, 10) : 0
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

    let duration = 0;
    if (format.duration) {
      duration = parseFloat(format.duration);
    } else if (videoStream && videoStream.duration) {
      duration = parseFloat(videoStream.duration);
    }

    return {
      filePath,
      formatName: format.format_name || '',
      duration,
      videoStreamPresent: Boolean(videoStream),
      videoStreamCount,
      videoCodec,
      width,
      height,
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
