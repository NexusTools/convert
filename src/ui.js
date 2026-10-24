import fs from 'fs';
import path from 'path';
import { selectBestHardwareEncoder } from './hwprobe.js';
import { scanDirectory } from './scanner.js';
import { BatchScheduler, getVideoTranscodeWorkload, getAudioTranscodeWorkload } from './scheduler.js';
import { killAllActiveJobs, killAllActiveJobsSync, setupGlobalSignalHandler } from './transcoder.js';
import { formatDuration } from './utils.js';

/**
 * Escapes HTML special characters for safe DOM rendering.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats an active interval window (ms) into a concise human-readable label (e.g., "15s", "2m", "15m").
 * @param {number} windowMs
 * @param {boolean} isFull15Min
 * @returns {string}
 */
function formatIntervalWindowLabel(windowMs, isFull15Min) {
  if (!windowMs || windowMs <= 0) return 'Immediate*';
  const sec = Math.round(windowMs / 1000);
  const suffix = isFull15Min ? '' : '*';
  if (sec >= 60) {
    return `${Math.round(sec / 60)}m${suffix}`;
  }
  return `${sec}s${suffix}`;
}

/**
 * Launches the NW.js Video & Audio Batch Transcoder UI.
 * Immediately opens the native OS folder picker asking for a directory to convert,
 * then displays overall progress bar, ETA, probing progress, and dual queue lists
 * for both the Video Queue and Audio-Only Queue.
 *
 * @param {Window} win
 */
export async function launchUi(win) {
  const doc = win.document;
  setupGlobalSignalHandler();

  // DOM References
  const nativeDirPicker = doc.getElementById('nativeDirPicker');
  const activeDirectoryLabel = doc.getElementById('activeDirectoryLabel');
  const gpuEncoderBadge = doc.getElementById('gpuEncoderBadge');
  const qualityLockedBadge = doc.getElementById('qualityLockedBadge');
  const addDirectoryBtn = doc.getElementById('addDirectoryBtn');

  // Quality Dialog Elements
  const qualityDialogModal = doc.getElementById('qualityDialogModal');
  const qualityDialogDirLabel = doc.getElementById('qualityDialogDirLabel');
  const dialogQualityInput = doc.getElementById('dialogQualityInput');
  const confirmQualityStartBtn = doc.getElementById('confirmQualityStartBtn');

  // Metrics & Progress Elements
  const jobsSummaryCounter = doc.getElementById('jobsSummaryCounter');
  const overallPercentLabel = doc.getElementById('overallPercentLabel');
  const completedFailedSub = doc.getElementById('completedFailedSub');
  const overallProgressBar = doc.getElementById('overallProgressBar');

  const etaWindowBadge = doc.getElementById('etaWindowBadge');
  const etaValueLabel = doc.getElementById('etaValueLabel');
  const etaBucketsSub = doc.getElementById('etaBucketsSub');
  const etaCadenceNote = doc.getElementById('etaCadenceNote');

  const probingStateBadge = doc.getElementById('probingStateBadge');
  const probingPercentLabel = doc.getElementById('probingPercentLabel');
  const probingCountLabel = doc.getElementById('probingCountLabel');
  const probingProgressBar = doc.getElementById('probingProgressBar');

  // Queue Containers & Counter Pills
  const videoActivePill = doc.getElementById('videoActivePill');
  const videoQueuedPill = doc.getElementById('videoQueuedPill');
  const videoDonePill = doc.getElementById('videoDonePill');
  const videoFailedPill = doc.getElementById('videoFailedPill');
  const videoQueueContainer = doc.getElementById('videoQueueContainer');

  const audioActivePill = doc.getElementById('audioActivePill');
  const audioQueuedPill = doc.getElementById('audioQueuedPill');
  const audioDonePill = doc.getElementById('audioDonePill');
  const audioFailedPill = doc.getElementById('audioFailedPill');
  const audioQueueContainer = doc.getElementById('audioQueueContainer');

  // Runtime State
  let activeScheduler = null;
  let skippedFilesCount = 0;
  let isQualityLocked = false;
  let lockedQualityNum = 24;
  let pendingInitialDir = null;
  const addedDirectories = [];
  let uiRefreshScheduled = false;
  let periodicTimer = null;
  let isClosingWindow = false;

  /**
   * Synchronously halts the active scheduler and deletes any unfinished output files.
   */
  function cleanupUnfinishedOutputsSync() {
    if (activeScheduler) {
      activeScheduler.isHalted = true;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
    try {
      killAllActiveJobsSync();
    } catch {}
  }

  // Register DOM unload hooks as an additional safeguard when NW.js closes
  win.addEventListener('beforeunload', cleanupUnfinishedOutputsSync);
  win.addEventListener('unload', cleanupUnfinishedOutputsSync);
  win.addEventListener('pagehide', cleanupUnfinishedOutputsSync);

  // Hook NW.js window taskbar icon/title and close event to cleanly terminate active FFmpeg processes & delete unfinished output files
  try {
    if (typeof nw !== 'undefined' && nw.Window && typeof nw.Window.get === 'function') {
      const nwWin = nw.Window.get();
      nwWin.title = 'NXTConverter';
      if (typeof nwWin.setShowInTaskbar === 'function') {
        nwWin.setShowInTaskbar(true);
      }
      nwWin.on('close', async () => {
        if (isClosingWindow) return;
        isClosingWindow = true;
        try {
          if (activeScheduler) {
            activeScheduler.isHalted = true;
          }
          if (periodicTimer) {
            clearInterval(periodicTimer);
            periodicTimer = null;
          }
          await killAllActiveJobs();
          killAllActiveJobsSync();
        } catch {}
        nwWin.close(true);
        try {
          if (nw.App && typeof nw.App.quit === 'function') {
            nw.App.quit();
          }
        } catch {}
        try {
          if (typeof process !== 'undefined' && typeof process.exit === 'function') {
            process.exit(win.isStartupErrorActive ? 1 : 0);
          }
        } catch {}
      });
    }
  } catch {}

  // Start probing GPU Hardware Encoder immediately in the background
  const hardwareEncoderPromise = (async () => {
    try {
      const encoder = await selectBestHardwareEncoder();
      const hdrText = encoder.supportsHdr ? '10-bit HDR' : 'SDR';
      gpuEncoderBadge.textContent = `GPU: ${encoder.targetEncoder} (${encoder.vendor} | ${hdrText})`;
      return encoder;
    } catch (err) {
      gpuEncoderBadge.textContent = `GPU Probe Error: ${err.message}`;
      gpuEncoderBadge.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      gpuEncoderBadge.style.color = '#fca5a5';
      if (typeof win.showStartupErrorModal === 'function') {
        win.showStartupErrorModal(err);
      }
      throw err;
    }
  })();
  hardwareEncoderPromise.catch(() => {});

  /**
   * Renders a video item card (active slot, queued item, completed item, or failed item).
   */
  function renderVideoQueueHtml(uiState) {
    const parts = [];

    // 1. Active Video Transcode
    parts.push(`<div class="section-label">Active Video Transcode</div>`);
    if (uiState.activeVideoSlot) {
      const slot = uiState.activeVideoSlot;
      const item = slot.item;
      const meta = item.metadata || {};
      const plan = item.plan || {};
      const pct = Math.min(100, Math.max(0, slot.percent || 0)).toFixed(1);
      const speedStr = (slot.speed || 0).toFixed(1);
      const resStr = meta.width && meta.height ? `${meta.width}x${meta.height}` : 'Unknown res';
      const hdrTag = meta.isHdr ? (plan.isHdr ? '10-bit HDR' : 'HDR->SDR') : (meta.is10Bit ? '10-bit SDR' : 'SDR');
      const timeStr = `${formatDuration(slot.currentTimeSec || 0)} / ${formatDuration(slot.totalDuration || meta.duration || 0)}`;

      parts.push(`
        <div class="slot-card active-slot">
          <div class="slot-top-row">
            <span class="slot-badge">${pct}% (${speedStr}x)</span>
            <div class="file-title" title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath || item.fileName)}</div>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${pct}%;"></div>
          </div>
          <div class="slot-meta-row">
            <span>${escapeHtml(resStr)} &bull; ${escapeHtml(hdrTag)} &bull; ${(meta.audioStreams || []).length} Audio / ${(meta.subtitleStreams || []).length} Sub</span>
            <span>${escapeHtml(timeStr)}</span>
          </div>
          <div class="codec-plan" title="${escapeHtml(plan.targetVideoCodecDisplay)} | ${escapeHtml(plan.targetAudioCodecDisplay)}">
            V: ${escapeHtml(plan.targetVideoCodecDisplay)} | A: ${escapeHtml(plan.targetAudioCodecDisplay)}
          </div>
        </div>
      `);
    } else {
      parts.push(`<div class="empty-state" style="padding: 14px;">No active video transcode</div>`);
    }

    // 2. Queued Video Items
    parts.push(`<div class="section-label">Queued Video Jobs (${uiState.videoQueue.length})</div>`);
    if (uiState.videoQueue.length === 0) {
      parts.push(`<div class="empty-state" style="padding: 14px;">No pending items in Video Queue</div>`);
    } else {
      uiState.videoQueue.slice(0, 120).forEach((item, idx) => {
        const meta = item.metadata || {};
        const plan = item.plan || {};
        const resStr = meta.width && meta.height ? `${meta.width}x${meta.height}` : 'Video';
        const hdrTag = meta.isHdr ? 'HDR' : 'SDR';
        const weight = Math.round(getVideoTranscodeWorkload(item));
        parts.push(`
          <div class="slot-card">
            <div class="slot-top-row">
              <span class="pill">#${idx + 1}</span>
              <div class="file-title" title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath || item.fileName)}</div>
              <span class="pill">${escapeHtml(formatDuration(meta.duration || 0))}</span>
            </div>
            <div class="slot-meta-row">
              <span>${escapeHtml(resStr)} (${escapeHtml(hdrTag)}) &bull; ${(meta.audioStreams || []).length} audio / ${(meta.subtitleStreams || []).length} sub</span>
              <span>Weight: ${weight}</span>
            </div>
            <div class="codec-plan" title="${escapeHtml(plan.targetVideoCodecDisplay)}">
              ${escapeHtml(plan.targetVideoCodecDisplay)}
            </div>
          </div>
        `);
      });
      if (uiState.videoQueue.length > 120) {
        parts.push(`<div class="metric-sub" style="text-align: center; padding: 6px;">+ ${uiState.videoQueue.length - 120} more queued video files...</div>`);
      }
    }

    // 3. Completed / Failed Video Items
    const finishedVideo = [...uiState.failedVideoItems, ...uiState.completedVideoItems].slice(-40).reverse();
    if (finishedVideo.length > 0) {
      parts.push(`<div class="section-label">Completed / Failed Video Jobs (${uiState.completedVideoCount + uiState.failedVideoCount})</div>`);
      for (const entry of finishedVideo) {
        const isFailed = entry.status === 'failed';
        parts.push(`
          <div class="slot-card ${isFailed ? 'failed-item' : 'completed-item'}">
            <div class="slot-top-row">
              <span class="pill ${isFailed ? 'failed' : 'done'}">${isFailed ? 'FAILED' : 'DONE'}</span>
              <div class="file-title" title="${escapeHtml(entry.item.filePath)}">${escapeHtml(entry.item.filePath || entry.item.fileName)}</div>
            </div>
            ${isFailed ? `<div class="codec-plan" style="color: #fca5a5;">${escapeHtml(entry.error || 'Transcode error')}</div>` : ''}
          </div>
        `);
      }
    }

    return parts.join('');
  }

  /**
   * Renders the Audio-Only Queue column (4 Active Slots A1-A4, Queued Audio Items, Completed/Failed).
   */
  function renderAudioQueueHtml(uiState) {
    const parts = [];

    // 1. Active Audio Transcodes
    parts.push(`<div class="section-label">Active Audio Transcodes</div>`);
    const anyActiveAudio = uiState.activeAudioSlots.some((s) => s !== null);
    if (!anyActiveAudio) {
      parts.push(`<div class="empty-state" style="padding: 14px;">No active audio transcodes</div>`);
    } else {
      uiState.activeAudioSlots.forEach((slot) => {
        if (!slot) return;
        const item = slot.item;
        const meta = item.metadata || {};
        const plan = item.plan || {};
        const pct = Math.min(100, Math.max(0, slot.percent || 0)).toFixed(1);
        const speedStr = (slot.speed || 0).toFixed(1);
        const timeStr = `${formatDuration(slot.currentTimeSec || 0)} / ${formatDuration(slot.totalDuration || meta.duration || 0)}`;

        parts.push(`
          <div class="slot-card active-slot">
            <div class="slot-top-row">
              <span class="slot-badge">${pct}% (${speedStr}x)</span>
              <div class="file-title" title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath || item.fileName)}</div>
            </div>
            <div class="progress-track">
              <div class="progress-fill audio-fill" style="width: ${pct}%;"></div>
            </div>
            <div class="slot-meta-row">
              <span>${plan.isAudioOnlyFile ? 'Standalone Audio (.opus)' : `Video Copy (${escapeHtml(meta.videoCodec || 'copy')})`}</span>
              <span>${escapeHtml(timeStr)}</span>
            </div>
            <div class="codec-plan" title="${escapeHtml(plan.targetAudioCodecDisplay)}">
              ${escapeHtml(plan.targetAudioCodecDisplay)}
            </div>
          </div>
        `);
      });
    }

    // 2. Queued Audio-Only Items
    parts.push(`<div class="section-label">Queued Audio-Only Jobs (${uiState.audioOnlyQueue.length})</div>`);
    if (uiState.audioOnlyQueue.length === 0) {
      parts.push(`<div class="empty-state" style="padding: 14px;">No pending items in Audio-Only Queue</div>`);
    } else {
      uiState.audioOnlyQueue.slice(0, 120).forEach((item, idx) => {
        const meta = item.metadata || {};
        const plan = item.plan || {};
        const weight = Math.round(getAudioTranscodeWorkload(item));
        parts.push(`
          <div class="slot-card">
            <div class="slot-top-row">
              <span class="pill">#${idx + 1}</span>
              <div class="file-title" title="${escapeHtml(item.filePath)}">${escapeHtml(item.filePath || item.fileName)}</div>
              <span class="pill">${escapeHtml(formatDuration(meta.duration || 0))}</span>
            </div>
            <div class="slot-meta-row">
              <span>${plan.isAudioOnlyFile ? 'Standalone Audio -> .opus' : `Video Stream Copy (${escapeHtml(meta.videoCodec || 'copy')})`}</span>
              <span>Weight: ${weight}</span>
            </div>
            <div class="codec-plan" title="${escapeHtml(plan.targetAudioCodecDisplay)}">
              ${escapeHtml(plan.targetAudioCodecDisplay)}
            </div>
          </div>
        `);
      });
      if (uiState.audioOnlyQueue.length > 120) {
        parts.push(`<div class="metric-sub" style="text-align: center; padding: 6px;">+ ${uiState.audioOnlyQueue.length - 120} more queued audio-only files...</div>`);
      }
    }

    // 3. Completed / Failed Audio Items
    const finishedAudio = [...uiState.failedAudioItems, ...uiState.completedAudioItems].slice(-40).reverse();
    if (finishedAudio.length > 0) {
      parts.push(`<div class="section-label">Completed / Failed Audio Jobs (${uiState.completedAudioCount + uiState.failedAudioCount})</div>`);
      for (const entry of finishedAudio) {
        const isFailed = entry.status === 'failed';
        parts.push(`
          <div class="slot-card ${isFailed ? 'failed-item' : 'completed-item'}">
            <div class="slot-top-row">
              <span class="pill ${isFailed ? 'failed' : 'done'}">${isFailed ? 'FAILED' : 'DONE'}</span>
              <div class="file-title" title="${escapeHtml(entry.item.filePath)}">${escapeHtml(entry.item.filePath || entry.item.fileName)}</div>
            </div>
            ${isFailed ? `<div class="codec-plan" style="color: #fca5a5;">${escapeHtml(entry.error || 'Transcode error')}</div>` : ''}
          </div>
        `);
      }
    }

    return parts.join('');
  }

  /**
   * Renders the current BatchScheduler UI state to all DOM elements.
   */
  function renderDashboard() {
    uiRefreshScheduled = false;
    if (!activeScheduler) return;

    const uiState = activeScheduler.getUiState();
    const totalCompleted = uiState.completedVideoCount + uiState.completedAudioCount;
    const totalFailed = uiState.failedVideoCount + uiState.failedAudioCount;
    const totalProcessedJobs = totalCompleted + totalFailed;

    // 1. Overall Progress Bar
    const overallPctStr = uiState.overallPercent.toFixed(1);
    overallPercentLabel.textContent = `${overallPctStr}%`;
    overallProgressBar.style.width = `${overallPctStr}%`;
    jobsSummaryCounter.textContent = `${totalProcessedJobs} / ${uiState.totalJobsCount} Jobs`;
    completedFailedSub.textContent = `${totalCompleted} Completed | ${totalFailed} Failed | ${skippedFilesCount} Skipped`;

    // 2. ETA & 15-Minute Staged Window Display
    const eta = uiState.eta;
    if (uiState.isProbing && uiState.totalJobsCount === 0) {
      etaValueLabel.textContent = 'Probing...';
      etaWindowBadge.textContent = 'Window: Probing';
    } else if (!uiState.isProbing && totalProcessedJobs >= uiState.totalJobsCount && !uiState.activeVideoSlot && uiState.activeAudioSlots.every((s) => !s)) {
      etaValueLabel.textContent = '0m00s (Done)';
      etaWindowBadge.textContent = 'Batch Complete';
    } else {
      etaValueLabel.textContent = eta.etaFormatted;
      const winLabel = formatIntervalWindowLabel(eta.activeWindowMs, eta.isFull15MinEstablished);
      etaWindowBadge.textContent = `Window: ${winLabel}`;
    }
    etaBucketsSub.textContent = `History: ${eta.historyBucketCount || 0} / 60 (15s buckets | Active: ${eta.activeIntervalBucketCount || 0})`;
    etaCadenceNote.textContent = eta.isFull15MinEstablished
      ? 'Full 15m history established (updates every 15s)'
      : 'Updates every 15s once \u226515s fetched (* = <15m history)';

    // 3. Probing Progress Bar
    const probePctStr = (uiState.probingPercent || 0).toFixed(1);
    probingPercentLabel.textContent = `${probePctStr}%`;
    probingProgressBar.style.width = `${probePctStr}%`;
    probingCountLabel.textContent = `${uiState.probingProcessed} / ${uiState.probingTotal} files probed`;
    probingStateBadge.textContent = uiState.isProbing ? 'Probing (4 Workers)...' : 'Probing Complete';

    // 4. Queue Pills & Lists
    const activeVideoCount = uiState.activeVideoSlot ? 1 : 0;
    videoActivePill.textContent = `Active: ${activeVideoCount}/1`;
    videoQueuedPill.textContent = `Queued: ${uiState.videoQueue.length}`;
    videoDonePill.textContent = `Done: ${uiState.completedVideoCount}`;
    videoFailedPill.textContent = `Failed: ${uiState.failedVideoCount}`;
    videoQueueContainer.innerHTML = renderVideoQueueHtml(uiState);

    const activeAudioCount = uiState.activeAudioSlots.filter(Boolean).length;
    audioActivePill.textContent = `Active: ${activeAudioCount}/4`;
    audioQueuedPill.textContent = `Queued: ${uiState.audioOnlyQueue.length}`;
    audioDonePill.textContent = `Done: ${uiState.completedAudioCount}`;
    audioFailedPill.textContent = `Failed: ${uiState.failedAudioCount}`;
    audioQueueContainer.innerHTML = renderAudioQueueHtml(uiState);
  }

  function scheduleDashboardRender() {
    if (uiRefreshScheduled) return;
    uiRefreshScheduled = true;
    win.requestAnimationFrame(renderDashboard);
  }

  /**
   * Opens the native OS folder selector dialog.
   */
  function openNativeOsFolderDialog() {
    nativeDirPicker.value = '';
    nativeDirPicker.click();
  }

  /**
   * Updates the header directory summary string with all directories added to the batch.
   */
  function updateActiveDirectoryHeader() {
    if (addedDirectories.length === 0) {
      activeDirectoryLabel.textContent = 'Select a directory to begin conversion...';
    } else if (addedDirectories.length === 1) {
      activeDirectoryLabel.textContent = `Directory: ${addedDirectories[0]}`;
    } else {
      activeDirectoryLabel.textContent = `Directories (${addedDirectories.length}): ${addedDirectories.join(' | ')}`;
    }
  }

  /**
   * Displays the Quality Configuration Dialog for the initially selected directory before scanning/transcoding begins.
   * @param {string} selectedDir
   */
  function showQualityDialogForDirectory(selectedDir) {
    const resolvedDir = path.resolve(selectedDir);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return;
    }
    pendingInitialDir = resolvedDir;
    qualityDialogDirLabel.textContent = `Selected Directory: "${resolvedDir}"`;
    dialogQualityInput.value = '24';
    qualityDialogModal.classList.remove('hidden');
    setTimeout(() => {
      try {
        dialogQualityInput.focus();
        dialogQualityInput.select();
      } catch {}
    }, 30);
  }

  /**
   * Adds a directory to probe and transcode using the locked quality setting.
   * Creates the BatchScheduler on the first directory, and appends to the existing BatchScheduler
   * when additional directories are added via "Add Directory".
   *
   * @param {string} targetDir
   */
  async function addDirectoryToBatch(targetDir) {
    if (!targetDir) return;
    const resolvedDir = path.resolve(targetDir);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return;
    }

    if (!addedDirectories.includes(resolvedDir)) {
      addedDirectories.push(resolvedDir);
    }
    updateActiveDirectoryHeader();

    let systemEncoder;
    try {
      systemEncoder = await hardwareEncoderPromise;
    } catch (err) {
      activeDirectoryLabel.textContent = `Fatal Error: ${err.message}`;
      return;
    }

    if (!activeScheduler || activeScheduler.isHalted) {
      activeScheduler = new BatchScheduler({
        qualityNum: lockedQualityNum,
        onStateChange: () => scheduleDashboardRender()
      });
      activeScheduler.start().catch((err) => {
        console.error('Batch scheduler error:', err);
      });
    }

    if (!periodicTimer) {
      periodicTimer = setInterval(() => scheduleDashboardRender(), 1000);
    }

    scheduleDashboardRender();

    try {
      const scanResult = await scanDirectory(resolvedDir, activeScheduler, systemEncoder);
      if (scanResult && Array.isArray(scanResult.skippedList)) {
        skippedFilesCount += scanResult.skippedList.length;
        scheduleDashboardRender();
      }
    } catch (err) {
      console.error(`Error scanning directory "${resolvedDir}":`, err);
    } finally {
      scheduleDashboardRender();
    }
  }

  /**
   * Locks in the user's chosen quality from the dialog and starts scanning/transcoding the initial directory.
   */
  function confirmQualityAndStart() {
    if (!pendingInitialDir) return;
    const rawVal = dialogQualityInput.value ? dialogQualityInput.value.trim() : '';
    let parsedQuality = 24;
    if (rawVal !== '') {
      const n = parseInt(rawVal, 10);
      if (!isNaN(n) && n >= 0 && n <= 51) {
        parsedQuality = n;
      }
    }

    lockedQualityNum = parsedQuality;
    isQualityLocked = true;
    dialogQualityInput.disabled = true;
    qualityLockedBadge.textContent = `Quality: ${lockedQualityNum} (Locked)`;
    qualityLockedBadge.classList.add('active');
    qualityDialogModal.classList.add('hidden');

    const initialDir = pendingInitialDir;
    pendingInitialDir = null;
    addDirectoryToBatch(initialDir);
  }

  // Wire up OS Folder Picker ("Add Directory") & Quality Confirmation Dialog Event Listeners
  addDirectoryBtn.addEventListener('click', () => {
    openNativeOsFolderDialog();
  });

  nativeDirPicker.addEventListener('change', () => {
    const selectedPath = nativeDirPicker.value;
    if (selectedPath && selectedPath.trim()) {
      const trimmed = selectedPath.trim();
      if (!isQualityLocked) {
        // First directory selected: show Quality Configuration Dialog before scanning & transcoding
        showQualityDialogForDirectory(trimmed);
      } else {
        // Subsequent directories added via "Add Directory": immediately scan & probe with locked quality
        addDirectoryToBatch(trimmed);
      }
    }
  });

  confirmQualityStartBtn.addEventListener('click', () => {
    confirmQualityAndStart();
  });

  dialogQualityInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmQualityAndStart();
    }
  });

  // Trigger the native OS directory picker the second the UI opens
  openNativeOsFolderDialog();
}
