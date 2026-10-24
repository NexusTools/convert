import fs from 'fs/promises';
import path from 'path';
import { isCandidateVideoFile, isCandidateAudioFile, isCandidateMediaFile, isMp4File, isWebmFile, isMkvFile, isOpusFile, formatBytes, calculateAudioBitrateKbps } from './utils.js';
import { probeMediaFile } from './probe.js';
import { TRANSCODE_CONFIG, CANDIDATE_VIDEO_EXTENSIONS, CANDIDATE_AUDIO_EXTENSIONS, getCodecRank } from './config.js';

const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'vobsub',
  'dvb_subtitle',
  'xsub',
  'arib_caption',
  'pgssub',
  'dvdsub'
]);

/**
 * Determines whether a file requires transcoding based on video and audio stream codecs,
 * system target hardware encoder rank, and container output rules (.mkv for .webm inputs, .webm for all other videos).
 *
 * @param {Object} metadata Probe metadata for the media file.
 * @param {string} filePath File path of candidate video or audio.
 * @param {Object} [systemEncoder] System target hardware encoder details from hwprobe.js
 * @returns {Object} Transcode plan details.
 */
export function determineTranscodeConfig(metadata, filePath, systemEncoder = null) {
  const { videoCodec, audioStreams = [], subtitleStreams = [], hasAttachments = false } = metadata;
  const isAudioOnlyFile = isCandidateAudioFile(filePath) || (!metadata.videoStreamPresent && metadata.audioStreamPresent);
  const isInputWebm = isWebmFile(filePath);
  const isInputMp4 = isMp4File(filePath);
  const hasSubtitles = subtitleStreams.length > 0;

  // System target hardware encoder parameters
  const targetRank = systemEncoder ? systemEncoder.targetRank : 4; // Default HEVC rank 4
  const targetEncoderName = systemEncoder ? systemEncoder.targetEncoder : 'hevc_amf';
  const targetCodecName = systemEncoder ? systemEncoder.targetCodec : 'hevc';
  const supportsHdr = systemEncoder ? systemEncoder.supportsHdr : false;

  const sourceVideoRank = getCodecRank(videoCodec);

  // Standalone audio files convert to .opus
  if (isAudioOnlyFile) {
    const primaryAudio = audioStreams[0] || {};
    const codec = (primaryAudio.codec || '').toLowerCase();
    const needsTranscode = codec !== 'opus';

    const audioStreamPlans = audioStreams.map((aStream) => {
      const aCodec = (aStream.codec || '').toLowerCase();
      const aNeedsTranscode = aCodec !== 'opus';
      const aKbps = calculateAudioBitrateKbps(aCodec, 'opus', aStream.channels || 2, aStream.bitrate);
      return {
        audioIndex: aStream.audioIndex,
        streamIndex: aStream.streamIndex,
        channels: aStream.channels || 2,
        origCodec: aStream.codec,
        needsTranscode: aNeedsTranscode,
        encoder: 'libopus',
        bitrateKbps: aKbps,
        display: `${aCodec} (${aStream.channels || 2}ch, ${aStream.bitrate ? Math.round(aStream.bitrate/1000) + 'k' : 'auto'}) -> opus (${aStream.channels || 2}ch, ${aKbps}k)`
      };
    });

    const targetAudioCodecDisplay = audioStreamPlans.length > 0
      ? audioStreamPlans.map((p) => p.display).join(' | ')
      : 'none';

    return {
      needsTranscode,
      isAudioOnlyFile: true,
      isInputMp4: false,
      isInputWebm: false,
      hasSubtitles: false,
      hasImageSubtitles: false,
      hasAttachments: false,
      targetExt: '.opus',
      transcodeVideo: false,
      videoStreamCount: 0,
      isHdr: false,
      sourceIsHdr: false,
      is10Bit: false,
      targetVideoCodec: 'none',
      targetVideoCodecDisplay: 'none',
      audioStreamPlans,
      subtitleStreamPlans: [],
      targetAudioCodecDisplay,
      subtitleAction: 'none'
    };
  }

  // Video files container output selection rule:
  // No media is ever transcoded to .mp4!
  // - If input is .webm => target is .mkv
  // - If input is .mkv, .mp4, or any other video format => target is .webm
  const targetExt = isInputWebm ? '.mkv' : '.webm';

  const hasImageSubtitles = subtitleStreams.some((sStream) => {
    const c = (sStream.codec || '').toLowerCase();
    return IMAGE_SUBTITLE_CODECS.has(c) || c.includes('pgs') || c.includes('dvd') || c.includes('vob');
  });

  // Video Decision based on Codec Hierarchy Ranks
  let transcodeVideo = false;
  let targetVideoCodec = 'copy';
  let targetVideoCodecDisplay = `${videoCodec || 'unknown'} (copy)`;
  const encodeAsHdr = Boolean(metadata.isHdr && supportsHdr);

  if (metadata.videoStreamPresent) {
    if (sourceVideoRank > targetRank) {
      // Always re-encode any video codec below target rank (e.g. h264 -> hevc) even if downgrading HDR to SDR!
      transcodeVideo = true;
      targetVideoCodec = targetEncoderName;
      const hdrNote = metadata.isHdr ? (supportsHdr ? ' 10-bit HDR' : ' SDR') : '';
      targetVideoCodecDisplay = `${videoCodec || 'unknown'} -> ${targetCodecName.toUpperCase()} (${targetEncoderName}${hdrNote})`;
    } else {
      // Source codec is equally or more efficient -> Passthrough copy
      transcodeVideo = false;
      targetVideoCodecDisplay = `${videoCodec || 'unknown'} (copy)`;
    }
  }

  const audioStreamPlans = audioStreams.map((aStream) => {
    let codec = aStream.codec;
    if (codec === 'ec-3') codec = 'eac3';

    let needsTranscode = false;
    let encoder = 'copy';
    let downmixTo5Point1 = false;
    let bitrateKbps = 0;
    let display = `${codec} (${aStream.channels}ch, copy)`;

    if (aStream.channels > 6) {
      // Downmix audio tracks > 6 channels to EAC3 5.1 (capped at 640k optical audio limit)
      needsTranscode = true;
      encoder = TRANSCODE_CONFIG.AUDIO.MANY_CHANNELS_TARGET_CODEC; // eac3
      downmixTo5Point1 = true;
      bitrateKbps = calculateAudioBitrateKbps(codec, 'eac3', 6, aStream.bitrate);
      display = `${codec} (${aStream.channels}ch, ${aStream.bitrate ? Math.round(aStream.bitrate/1000) + 'k' : 'auto'}) -> ${TRANSCODE_CONFIG.AUDIO.MANY_CHANNELS_TARGET_CODEC} (6ch 5.1 downmix, ${bitrateKbps}k)`;
    } else if (aStream.channels >= TRANSCODE_CONFIG.AUDIO.MANY_CHANNELS_THRESHOLD) {
      if (codec !== TRANSCODE_CONFIG.AUDIO.MANY_CHANNELS_TARGET_CODEC) {
        needsTranscode = true;
        encoder = TRANSCODE_CONFIG.AUDIO.MANY_CHANNELS_TARGET_CODEC; // eac3
        bitrateKbps = calculateAudioBitrateKbps(codec, 'eac3', aStream.channels, aStream.bitrate);
        display = `${codec} (${aStream.channels}ch, ${aStream.bitrate ? Math.round(aStream.bitrate/1000) + 'k' : 'auto'}) -> ${TRANSCODE_CONFIG.AUDIO.MANY_CHANNELS_TARGET_CODEC} (${aStream.channels}ch, ${bitrateKbps}k)`;
      } else {
        display = `${codec} (${aStream.channels}ch, copy)`;
      }
    } else if (aStream.channels > 0) {
      if (codec !== TRANSCODE_CONFIG.AUDIO.FEW_CHANNELS_TARGET_CODEC) {
        needsTranscode = true;
        encoder = TRANSCODE_CONFIG.AUDIO.FEW_CHANNELS_FFMPEG_ENCODER; // libopus
        bitrateKbps = calculateAudioBitrateKbps(codec, 'opus', aStream.channels, aStream.bitrate);
        display = `${codec} (${aStream.channels}ch, ${aStream.bitrate ? Math.round(aStream.bitrate/1000) + 'k' : 'auto'}) -> opus (${aStream.channels}ch, ${bitrateKbps}k)`;
      } else {
        display = `${codec} (${aStream.channels}ch, copy)`;
      }
    }

    return {
      audioIndex: aStream.audioIndex,
      streamIndex: aStream.streamIndex,
      channels: aStream.channels,
      origCodec: aStream.codec,
      needsTranscode,
      encoder,
      downmixTo5Point1,
      bitrateKbps,
      display
    };
  });

  const anyAudioTranscode = audioStreamPlans.some((p) => p.needsTranscode);

  const subtitleStreamPlans = subtitleStreams.map((sStream) => {
    const c = (sStream.codec || '').toLowerCase();
    const isImageSub = IMAGE_SUBTITLE_CODECS.has(c) || c.includes('pgs') || c.includes('dvd') || c.includes('vob');
    const isTextSub = ['subrip', 'srt', 'ass', 'ssa', 'vtt', 'text', 'mov_text', 'webvtt', 'tx3g'].includes(c);

    let encoder = 'copy';

    // Matroska / WebM output formats convert mov_text to srt, and stream-copy all other subtitles
    if (c === 'mov_text' || c === 'tx3g') {
      encoder = 'srt';
    } else {
      encoder = 'copy';
    }

    return {
      subtitleIndex: sStream.subtitleIndex,
      streamIndex: sStream.streamIndex,
      origCodec: c,
      isImageSub,
      isTextSub,
      encoder
    };
  });

  const needsTranscode = transcodeVideo || anyAudioTranscode;

  const targetAudioCodecDisplay = audioStreamPlans.length > 0
    ? audioStreamPlans.map((p) => p.display).join(' | ')
    : 'none';

  const subtitleAction = subtitleStreamPlans.length > 0
    ? `${subtitleStreamPlans.length} stream(s) (${subtitleStreamPlans.map((s) => `${s.origCodec} -> ${s.encoder}`).join(', ')})`
    : 'none';

  return {
    needsTranscode,
    isAudioOnlyFile: false,
    isInputWebm,
    isInputMp4,
    hasSubtitles,
    hasImageSubtitles,
    hasAttachments,
    targetExt,
    transcodeVideo,
    videoStreamCount: metadata.videoStreamCount || 1,
    isHdr: encodeAsHdr,
    sourceIsHdr: Boolean(metadata.isHdr),
    is10Bit: Boolean(metadata.is10Bit),
    targetVideoCodec,
    targetVideoCodecDisplay,
    hwDeviceSpec: systemEncoder ? (systemEncoder.hwDeviceSpec || null) : null,
    requiresHwUpload: Boolean(systemEncoder && systemEncoder.requiresHwUpload),
    useMain10Profile: systemEncoder && typeof systemEncoder.useMain10Profile === 'boolean' ? systemEncoder.useMain10Profile : true,
    audioStreamPlans,
    subtitleStreamPlans,
    targetAudioCodecDisplay,
    subtitleAction
  };
}

/**
 * Checks if a file exists on disk.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively scans a directory to build a list of candidate video/audio files first,
 * detecting and unlinking leftover partial conversions from prior interrupted runs
 * ONLY when the original untranscoded source file still exists AND the leftover file size is strictly smaller.
 *
 * Probes candidate media files using up to 4 concurrent ffprobe workers in parallel,
 * feeding probed items dynamically to the scheduler so transcoding starts immediately.
 *
 * @param {string} dirPath Target directory path.
 * @param {Object} [scheduler] Optional active BatchScheduler to stream probed jobs to in real time.
 * @param {Object} [systemEncoder] System target hardware encoder specifications.
 * @returns {Promise<Object>} Scan results object.
 */
export async function scanDirectory(dirPath, scheduler = null, systemEncoder = null) {
  const candidateFiles = [];
  let opusIgnoredCount = 0;
  let leftoverCleanedCount = 0;

  // Phase 1: Directory Traversal - Detect leftover partial conversions & collect candidate media files
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    const fileEntries = entries.filter((e) => e.isFile());
    const dirEntries = entries.filter((e) => e.isDirectory());

    // Map baseName.toLowerCase() -> Map(ext.toLowerCase() => fullPath)
    const baseNameExtMap = new Map();

    for (const fileEntry of fileEntries) {
      const ext = path.extname(fileEntry.name).toLowerCase();
      const baseName = path.basename(fileEntry.name, ext).toLowerCase();
      const fullPath = path.join(currentDir, fileEntry.name);

      if (!baseNameExtMap.has(baseName)) {
        baseNameExtMap.set(baseName, new Map());
      }
      baseNameExtMap.get(baseName).set(ext, fullPath);
    }

    // Unlink leftover partial conversions based on container change formula and size safety check
    for (const [baseName, extMap] of baseNameExtMap.entries()) {
      // Formula Rule 1: .webm input converts to .mkv.
      // If .mkv output exists AND original .webm input STILL exists in the same directory:
      if (extMap.has('.mkv') && extMap.has('.webm')) {
        const leftoverMkvPath = extMap.get('.mkv');
        const originalWebmPath = extMap.get('.webm');

        try {
          const leftoverStat = await fs.stat(leftoverMkvPath);
          const originalStat = await fs.stat(originalWebmPath);

          if (leftoverStat.size < originalStat.size) {
            await fs.unlink(leftoverMkvPath);
            leftoverCleanedCount++;
            console.log(`[CLEANUP] Deleted leftover partial conversion: "${path.basename(leftoverMkvPath)}" (${formatBytes(leftoverStat.size)} < original ${formatBytes(originalWebmPath)})`);
            extMap.delete('.mkv');
          }
        } catch (err) {
          console.warn(`[WARN] Failed to process leftover check for "${leftoverMkvPath}": ${err.message}`);
        }
      }

      // Formula Rule 2: Non-WebM video input (.mkv, .mp4, .avi, etc.) converts to .webm.
      // If .webm output exists AND an original non-WebM candidate video file with same base name STILL exists:
      if (extMap.has('.webm')) {
        const nonWebmOriginalExt = Array.from(extMap.keys()).find(
          (ext) => ext !== '.webm' && CANDIDATE_VIDEO_EXTENSIONS.has(ext)
        );

        if (nonWebmOriginalExt) {
          const leftoverWebmPath = extMap.get('.webm');
          const originalSourcePath = extMap.get(nonWebmOriginalExt);

          try {
            const leftoverStat = await fs.stat(leftoverWebmPath);
            const originalStat = await fs.stat(originalSourcePath);

            if (leftoverStat.size < originalStat.size) {
              await fs.unlink(leftoverWebmPath);
              leftoverCleanedCount++;
              console.log(`[CLEANUP] Deleted leftover partial conversion: "${path.basename(leftoverWebmPath)}" (${formatBytes(leftoverStat.size)} < original ${formatBytes(originalSourcePath)})`);
              extMap.delete('.webm');
            }
          } catch (err) {
            console.warn(`[WARN] Failed to process leftover check for "${leftoverWebmPath}": ${err.message}`);
          }
        }
      }

      // Formula Rule 3: Standalone audio input (.mp3, .flac, .wav, etc.) converts to .opus.
      if (extMap.has('.opus')) {
        const audioOriginalExt = Array.from(extMap.keys()).find(
          (ext) => ext !== '.opus' && CANDIDATE_AUDIO_EXTENSIONS.has(ext)
        );

        if (audioOriginalExt) {
          const leftoverOpusPath = extMap.get('.opus');
          const originalAudioPath = extMap.get(audioOriginalExt);

          try {
            const leftoverStat = await fs.stat(leftoverOpusPath);
            const originalStat = await fs.stat(originalAudioPath);

            if (leftoverStat.size < originalStat.size) {
              await fs.unlink(leftoverOpusPath);
              leftoverCleanedCount++;
              console.log(`[CLEANUP] Deleted leftover partial conversion: "${path.basename(leftoverOpusPath)}" (${formatBytes(leftoverStat.size)} < original ${formatBytes(originalAudioPath)})`);
              extMap.delete('.opus');
            }
          } catch (err) {
            console.warn(`[WARN] Failed to process leftover check for "${leftoverOpusPath}": ${err.message}`);
          }
        }
      }
    }

    // Collect remaining candidate media files
    for (const fileEntry of fileEntries) {
      const fullPath = path.join(currentDir, fileEntry.name);
      if (await fileExists(fullPath)) {
        if (isOpusFile(fullPath)) {
          opusIgnoredCount++;
        } else if (isCandidateMediaFile(fullPath)) {
          candidateFiles.push({
            fullPath,
            fileName: fileEntry.name
          });
        }
      }
    }

    // Recurse into subdirectories
    for (const dirEntry of dirEntries) {
      await walk(path.join(currentDir, dirEntry.name));
    }
  }

  await walk(dirPath);

  const totalCandidates = candidateFiles.length;
  console.log(`[SCANNING] Traversed directory and found ${totalCandidates} candidate media file(s).`);

  if (scheduler && typeof scheduler.beginDirectoryProbe === 'function') {
    scheduler.beginDirectoryProbe(totalCandidates);
  }

  const videoQueue = [];
  const audioOnlyQueue = [];
  const skippedList = [];

  let totalVideoPoolDuration = 0;
  let totalAudioOnlyPoolDuration = 0;

  if (totalCandidates === 0) {
    if (scheduler) scheduler.markProbingComplete();
    return {
      scannedCandidateCount: 0,
      opusIgnoredCount,
      leftoverCleanedCount,
      videoQueue,
      audioOnlyQueue,
      skippedList,
      totalVideoPoolDuration: 0,
      totalAudioOnlyPoolDuration: 0
    };
  }

  // Phase 2: Concurrent Probing Phase (4 ffprobe workers in parallel)
  const CONCURRENT_PROBES = 4;
  let candidateIndex = 0;
  let processedCount = 0;
  let lastLoggedPercentStr = '';

  async function probeWorker() {
    while (candidateIndex < totalCandidates) {
      const i = candidateIndex++;
      if (i >= totalCandidates) break;

      const fileObj = candidateFiles[i];
      const { fullPath, fileName } = fileObj;

      try {
        const metadata = await probeMediaFile(fullPath);
        const plan = determineTranscodeConfig(metadata, fullPath, systemEncoder);

        const fileItem = {
          filePath: fullPath,
          fileName,
          metadata,
          plan
        };

        if (plan.transcodeVideo) {
          videoQueue.push(fileItem);
          totalVideoPoolDuration += metadata.duration || 0;
          if (scheduler) scheduler.enqueueItem(fileItem);
        } else if (plan.needsTranscode) {
          audioOnlyQueue.push(fileItem);
          totalAudioOnlyPoolDuration += metadata.duration || 0;
          if (scheduler) scheduler.enqueueItem(fileItem);
        } else {
          skippedList.push(fileItem);
        }
      } catch (err) {
        console.warn(`\n[WARN] Skipping unprobed file "${fullPath}": ${err.message}`);
      }

      processedCount++;
      const currentPercent = (processedCount / totalCandidates) * 100;
      const percentStr = currentPercent.toFixed(1);

      if (scheduler) {
        if (typeof scheduler.recordProbedCandidate === 'function') {
          scheduler.recordProbedCandidate();
        } else {
          scheduler.updateProbingStatus(processedCount, totalCandidates, percentStr);
        }
      } else {
        if (percentStr !== lastLoggedPercentStr || processedCount === totalCandidates) {
          lastLoggedPercentStr = percentStr;
          process.stdout.write(`\r\x1b[K[PROBING PROGRESS] Processed ${processedCount} of ${totalCandidates} media files (${percentStr}%)`);
        }
      }
    }
  }

  const workerCount = Math.min(CONCURRENT_PROBES, totalCandidates);
  const workerPromises = [];
  for (let w = 0; w < workerCount; w++) {
    workerPromises.push(probeWorker());
  }

  await Promise.all(workerPromises);

  if (scheduler) {
    scheduler.markProbingComplete();
  } else {
    process.stdout.write('\n');
  }

  return {
    scannedCandidateCount: totalCandidates,
    opusIgnoredCount,
    leftoverCleanedCount,
    videoQueue,
    audioOnlyQueue,
    skippedList,
    totalVideoPoolDuration,
    totalAudioOnlyPoolDuration
  };
}
