#!/usr/bin/env node

import path from 'path';
import fs from 'fs';
import { getFfmpegPath, getFfprobePath } from './config.js';
import { selectBestHardwareEncoder } from './hwprobe.js';
import { scanDirectory } from './scanner.js';
import { setupGlobalSignalHandler } from './transcoder.js';
import { BatchScheduler } from './scheduler.js';
import { promptUser, formatDuration } from './utils.js';

async function main() {
  console.log(`\n================================================================================`);
  console.log(`                     Video Batch Transcoder CLI v1.0.0                          `);
  console.log(`================================================================================`);

  // Register single process-wide signal handler
  setupGlobalSignalHandler();

  // Validate directory path argument
  const targetDirInput = process.argv[2] || '.';
  const targetDir = path.resolve(targetDirInput);

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`[ERROR] Target directory does not exist or is not a directory: "${targetDir}"`);
    process.exit(1);
  }

  // Validate executables
  const ffmpegBin = getFfmpegPath();
  const ffprobeBin = getFfprobePath();

  console.log(`[CONFIG] FFmpeg Executable : ${ffmpegBin}`);
  console.log(`[CONFIG] FFprobe Executable: ${ffprobeBin}`);
  console.log(`[CONFIG] Target Directory  : ${targetDir}`);

  // Probe GPU Hardware Video Encoders
  console.log(`\n[PROBING GPU] Probing GPU hardware video encoders... Please wait...`);
  const systemEncoder = await selectBestHardwareEncoder();

  const workingNames = systemEncoder.verifiedEncoders.map((e) => e.name).join(', ');

  console.log(`\n================================================================================`);
  console.log(`                     GPU HARDWARE VIDEO ENCODER PROBED                          `);
  console.log(`================================================================================`);
  console.log(`Working Hardware Encoders  : ${workingNames}`);
  console.log(`Selected Target Encoder    : ${systemEncoder.targetEncoder} (Target Codec: ${systemEncoder.targetCodec.toUpperCase()}, Rank ${systemEncoder.targetRank})`);
  console.log(`GPU Hardware Vendor        : ${systemEncoder.vendor}`);
  console.log(`10-bit HDR Hardware Support: ${systemEncoder.supportsHdr ? 'Verified (10-bit HDR enabled)' : 'Not Supported (HDR will be copied)'}`);
  console.log(`Planned Video Transcoding  : All videos below ${systemEncoder.targetCodec.toUpperCase()} rank -> ${systemEncoder.targetCodec.toUpperCase()} (${systemEncoder.targetEncoder})`);
  console.log(`================================================================================`);

  // Prompt user for target numeric quality setting
  console.log(`\n[QUALITY CONFIGURATION]`);
  console.log(`Video hardware encoding quality parameter for ${systemEncoder.targetCodec.toUpperCase()} (${systemEncoder.targetEncoder}):`);
  console.log(`  - Lower numbers  = Higher visual quality, larger file size`);
  console.log(`  - Higher numbers = Lower visual quality, smaller file size`);

  const qualityInput = await promptUser(`Enter target quality number [default: 24]: `);
  let qualityNum = 24;
  if (qualityInput) {
    const parsed = parseInt(qualityInput.trim(), 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 51) {
      qualityNum = parsed;
    } else {
      console.log(`[INFO] Invalid quality input "${qualityInput}". Using default quality 24.`);
    }
  }

  console.log(`[CONFIG] Target Encoding Quality: ${qualityNum}`);

  // Instantiate parallel scheduler upfront with chosen quality
  const scheduler = new BatchScheduler({ qualityNum });
  const startTime = Date.now();

  console.log(`\n[BATCH START] Initiating video batch conversion pipeline (1 Video Slot + 4 Audio Slots)...`);

  // Run scheduler in parallel with directory probing
  const schedulerPromise = scheduler.start();

  // Run directory scanner & prober concurrently, streaming jobs to scheduler in real time
  const scanPromise = scanDirectory(targetDir, scheduler, systemEncoder);

  try {
    const [result] = await Promise.all([schedulerPromise, scanPromise]);
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n================================================================================`);
    console.log(`                         BATCH TRANSCODING COMPLETE                             `);
    console.log(`================================================================================`);
    console.log(`Total Completed : ${result.completedCount}`);
    console.log(`Total Failed    : ${result.failedCount}`);
    console.log(`Total Time      : ${formatDuration(elapsedSec)}`);
    console.log(`================================================================================\n`);

    if (result.failedCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    const exitCode = typeof err.exitCode === 'number' && !isNaN(err.exitCode) ? err.exitCode : 1;
    console.error(`\n[EXIT] Batch execution terminated with exit code (${exitCode}).`);
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(`\n[FATAL ERROR] ${err.stack || err.message}`);
  process.exit(1);
});
