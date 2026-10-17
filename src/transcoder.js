import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { getFfmpegPath, TRANSCODE_CONFIG } from './config.js';
import { formatDuration } from './utils.js';

// Central process-wide active job registry
const activeJobs = new Set();
let processSignalHandlerRegistered = false;
let isShuttingDown = false;

/**
 * Gracefully sends SIGTERM to all active FFmpeg child processes, awaits their full exit,
 * and then erases all incomplete partial output files while leaving original source files untouched.
 */
export async function killAllActiveJobs() {
  const activeJobsArray = Array.from(activeJobs);
  activeJobs.clear();

  if (activeJobsArray.length === 0) return;

  // Step 1: Send SIGTERM to all active child processes and await their exit
  const killPromises = activeJobsArray.map((job) => {
    return new Promise((resolve) => {
      if (!job.childProcess || job.childProcess.killed) {
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

      // Fallback: SIGKILL if process hasn't exited within 1.5 seconds
      setTimeout(() => {
        if (!resolved && job.childProcess && !job.childProcess.killed) {
          try {
            job.childProcess.kill('SIGKILL');
          } catch (e) {}
        }
        setTimeout(done, 200);
      }, 1500);
    });
  });

  await Promise.all(killPromises);

  // Step 2: Now that all FFmpeg processes are confirmed dead and file locks released, erase output files
  const unlinkPromises = activeJobsArray.map(async (job) => {
    if (job.outputFilePath) {
      try {
        await fs.unlink(job.outputFilePath);
        console.log(`[CLEANUP] Erased partial output file: "${job.outputFilePath}"`);
      } catch (err) {
        // Retry once after 200ms in case Windows OS file lock release had a brief lag
        try {
          await new Promise((r) => setTimeout(r, 200));
          await fs.unlink(job.outputFilePath);
          console.log(`[CLEANUP] Erased partial output file (retry): "${job.outputFilePath}"`);
        } catch (e) {
          console.warn(`[WARN] Could not erase partial output file "${job.outputFilePath}": ${e.message}`);
        }
      }
    }
  });

  await Promise.all(unlinkPromises);
}

/**
 * Registers exactly 1 global process-wide signal handler for SIGINT/SIGTERM.
 */
export function setupGlobalSignalHandler() {
  if (processSignalHandlerRegistered) return;
  processSignalHandlerRegistered = true;

  const handleSignal = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    process.stdout.write('\n');
    console.log(`\n[CTRL+C] Received ${signal}. Terminating all active FFmpeg processes with SIGTERM...`);

    await killAllActiveJobs();

    console.log('[EXIT] Program terminated by user. Original video files left untouched.');
    process.exit(130);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

/**
 * Builds the FFmpeg command line arguments based on probe metadata and plan.
 * All video outputs (.mkv and .webm) use the Matroska container format (-f matroska).
 * All video streams are specified using stream-index specifiers (-c:v:0, -c:v:1) with no global -c:v copy.
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

    args.push('-progress', 'pipe:1', '-nostats');
    args.push(outputFilePath);
    return args;
  }

  // Video File Conversion (Outputs to .webm or .mkv using Matroska muxer -f matroska)
  const args = [
    '-y',
    '-avoid_negative_ts', 'make_zero',
    '-i', inputFilePath,
    '-map', '0:v?',
    '-map', '0:a?',
    '-map', '0:s?',
    '-map', '0:t?' // Map font/data attachments natively in Matroska
  ];

  // Video Stream Arguments (Stream-specific only - NEVER use global -c:v copy)
  const videoStreamCount = typeof plan.videoStreamCount === 'number'
    ? Math.max(1, plan.videoStreamCount)
    : 1;

  for (let vIdx = 0; vIdx < videoStreamCount; vIdx++) {
    if (vIdx === 0 && plan.transcodeVideo) {
      const targetEnc = plan.targetVideoCodec || TRANSCODE_CONFIG.VIDEO.TARGET_ENCODER || 'hevc_amf';
      const isHdr = Boolean(plan.isHdr);

      if (targetEnc.includes('amf')) {
        args.push('-c:v:0', targetEnc, '-rc', 'cqp', '-qp_p', String(qualityNum), '-qp_i', String(qualityNum), '-quality', 'quality');
        if (isHdr) {
          args.push('-pix_fmt', 'p010le', '-profile:v', 'main10');
        }
      } else if (targetEnc.includes('nvenc')) {
        args.push('-c:v:0', targetEnc, '-rc', 'constqp', '-qp', String(qualityNum), '-preset', 'p6');
        if (isHdr) {
          args.push('-pix_fmt', 'p010le', '-profile:v', 'main10');
        }
      } else if (targetEnc.includes('qsv')) {
        args.push('-c:v:0', targetEnc, '-global_quality', String(qualityNum));
        if (isHdr) {
          args.push('-pix_fmt', 'p010le', '-profile:v', 'main10');
        }
      } else if (targetEnc.includes('videotoolbox')) {
        args.push('-c:v:0', targetEnc, '-q:v', String(qualityNum));
        if (isHdr) {
          args.push('-pix_fmt', 'p010le', '-profile:v', 'main10');
        }
      } else {
        args.push('-c:v:0', targetEnc, '-qp', String(qualityNum));
        if (isHdr) {
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

  // Realtime progress reporting via pipe
  args.push('-progress', 'pipe:1', '-nostats');

  // Matroska container format for all video outputs (.mkv and .webm)
  args.push('-f', 'matroska');

  // Output file directly
  args.push(outputFilePath);

  return args;
}

/**
 * Converts timestamp string (HH:MM:SS.microseconds) to total seconds.
 * @param {string} timeStr
 * @returns {number}
 */
export function parseTimeStringToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hrs = parseFloat(parts[0]);
    const mins = parseFloat(parts[1]);
    const secs = parseFloat(parts[2]);
    return hrs * 3600 + mins * 60 + secs;
  }
  return 0;
}

/**
 * Spawns an individual FFmpeg transcode process and reports progress events to callback.
 *
 * @param {Object} fileItem Item containing filePath, metadata, and plan.
 * @param {Object} options Options { slotLabel, qualityNum, onProgressUpdate }.
 * @returns {Promise<void>}
 */
export async function spawnTranscodeJob(fileItem, options = {}) {
  const { filePath, metadata, plan } = fileItem;
  const { slotLabel = 'JOB', qualityNum = 24, onProgressUpdate = () => {} } = options;

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
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    jobState.childProcess = child;

    let progressData = {};
    const totalDuration = metadata.duration || 0;

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
        const currentTimeSec = parseTimeStringToSeconds(progressData['out_time']);
        const percent = totalDuration > 0
          ? Math.min(100, Math.max(0, (currentTimeSec / totalDuration) * 100))
          : 0;

        const frame = parseInt(progressData['frame'] || '0', 10);
        let speedNum = 1.0;
        const rawSpeed = progressData['speed'] || '1x';
        const speedMatch = rawSpeed.match(/([\d.]+)x/);
        if (speedMatch) {
          speedNum = parseFloat(speedMatch[1]);
        }

        onProgressUpdate({
          slotLabel,
          filePath,
          percent,
          currentTimeSec,
          totalDuration,
          frame,
          speed: speedNum,
          rawSpeed
        });
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
      activeJobs.delete(jobState);

      if (isShuttingDown) {
        return; // SIGINT handler handles exiting
      }

      if (code === 0) {
        try {
          // Erase original source file
          await fs.unlink(filePath);
          resolve();
        } catch (fsErr) {
          reject(new Error(`Failed post-processing file cleanup for "${filePath}": ${fsErr.message}`));
        }
      } else {
        // Clean up output file
        try {
          await fs.unlink(finalOutputPath);
          console.log(`[CLEANUP] Deleted incomplete output file: "${finalOutputPath}"`);
        } catch (e) {}

        const err = new Error(`FFmpeg exited with error code ${code}.\nFFmpeg Error Output:\n${stderrBuffer.slice(-1500)}`);
        err.exitCode = code;
        reject(err);
      }
    });
  });
}
