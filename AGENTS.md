# AGENTS.md - Developer & Agent Operational Guide

This document defines the operational rules, architecture, and transcoding logic for the **Video Batch Transcoder CLI**.

---

## 1. Executive Summary & Domain Rules

The Video Batch Transcoder CLI is a Node.js utility designed to scan a target directory for video and audio files, probe their streams asynchronously using `ffprobe`, and selectively transcode them according to strict codec and container rules using **GPU Hardware Acceleration** for video and multi-slot parallel queue scheduling.

### Primary Transcoding Matrix

#### Dynamic GPU Hardware Video Encoder Probing (`src/hwprobe.js`)
- At startup, the CLI probes FFmpeg (`ffmpeg -encoders`) and tests candidate video hardware encoders with 0.2s 4K UHD (3840x2160) synthetic test spawns to verify active GPU driver support:
  - **AMD AMF**: `av1_amf`, `vp9_amf`, `hevc_amf`, `h264_amf`
  - **NVIDIA NVENC**: `av1_nvenc`, `vp9_nvenc`, `hevc_nvenc`, `h264_nvenc`
  - **Intel QSV**: `av1_qsv`, `vp9_qsv`, `hevc_qsv`, `h264_qsv`
  - **Apple VideoToolbox**: `hevc_videotoolbox`, `h264_videotoolbox`
  - **VAAPI / Vulkan**: `av1_vaapi`, `vp9_vaapi`, `hevc_vaapi`, `h264_vaapi`, `av1_vulkan`, `hevc_vulkan`, `h264_vulkan`
- **4K HDR Hardware Test Rule**: Synthetic HDR tests are performed at 4K resolution (`size=3840x2160`) so 10-bit HDR hardware encoding is reported supported ONLY if the GPU hardware supports 4K 10-bit HDR encoding.
- **Hardware-Only Requirement**: If no functional GPU hardware video encoder is verified on the system, the CLI terminates immediately with a fatal error.

#### 5-Tier Codec Efficiency Hierarchy & Video Transcoding Rule
- **Codec Efficiency Hierarchy**:
  1. `av1` (Rank 1 - Most efficient)
  2. `vp9` (Rank 2)
  3. `vp8` (Rank 3)
  4. `hevc` / `h265` (Rank 4)
  5. `h264` / `avc` (Rank 5 - Least efficient in hierarchy)
  - Legacy / Others (`mpeg4`, `mpeg2video`, `vc1`, `wmv3`, `flv1`, `theora`, `mjpeg`, etc.): Rank 99
- **Selection**: Selects the **highest rank verified hardware encoder** on the system as `systemEncoder`.
- **Transcode Decision**:
  - **Passthrough (`-c:v copy`)**: Any video using a codec with `sourceVideoRank <= systemTargetRank` (i.e. equally or more efficient than the system's target codec).
  - **Mandatory Transcode**: Any video using a codec with `sourceVideoRank > systemTargetRank` (e.g., `h264`, `mpeg4`, `mpeg2video`, etc.) **MUST ALWAYS BE TRANSCODED** to `systemEncoder.targetEncoder`, even if the source video is HDR and even if it means encoding in SDR when the GPU lacks 4K HDR hardware encoding support.

#### Startup Sequence & Interactive Quality Prompt
1. **GPU Hardware Probing**: Probes and verifies GPU hardware video encoders at 4K resolution.
2. **Console Target Codec Dump**: Prints a summary block to the console showing detected working hardware encoders, selected target encoder, vendor, 10-bit HDR support, and planned transcode mapping.
3. **Interactive Quality Prompt**: Prompts user for target numeric quality setting (default: `24`), explaining that lower numbers yield higher visual quality/larger file sizes and higher numbers yield lower visual quality/smaller file sizes.

#### Standalone Audio Files & Audio Track Rule
- **Standalone Audio Files** (`.mp3`, `.m4a`, `.wav`, `.flac`, `.aac`, `.ogg`, `.wma`, `.aiff`, `.alac`, `.ape`):
  - **Rule**: All non-Opus standalone audio files are transcoded to **`.opus`** (`libopus`), queued in the Audio-Only Transcode Queue (up to 4 concurrent slots), and original source files deleted on success.
- **Dynamic Codec-Aware Bitrate Algorithm** (`calculateAudioBitrateKbps`):
  - **EAC3 Transcoding & Optical Audio Bandwidth Limit**:
    - **Optical Audio (TOSLINK / S-PDIF) Limit**: EAC3 bitrate MUST NEVER EXCEED **640 kbps** (`Math.min(640, calculatedKbps)`).
    - Lossless surround sources (5.1 FLAC/WAV/PCM) receive maximum allowed optical audio bitrate (**640 kbps**).
  - **Opus Transcoding**:
    - **Lossless Sources** (`flac`, `alac`, `wav`, `pcm`, `ape`): High-fidelity Opus encoding (**256 kbps** for stereo, **128 kbps** for mono, **384 kbps** for 5.1).
    - **Lossy Sources**: Calculates target Opus bitrate based on original bitrate and codec efficiency multiplier relative to Opus.
- **$> 6$ Channels** (7.1, 9.1, etc.): Must be transcoded to `eac3` and downmixed to 6 channels (5.1 layout), dropping middle surround channels while preserving Front, Back, Center, and Sub/LFE (`-filter:a "pan=5.1|FL=c0|FR=c1|FC=c2|LFE=c3|BL=c4|BR=c5"`).
- **$3 \le \text{Channels} \le 6$**: If audio codec is not `eac3` (or `ec-3`), transcode to `eac3` (capped at 640 kbps). Otherwise copy (`-c:a copy`).
- **$\le 2$ Channels**: If audio codec is not `opus`, transcode to `opus` (`libopus`) using the dynamic bitrate algorithm. Otherwise copy (`-c:a copy`).

#### Subtitle Rule
- **Image-Based Subtitles** (`hdmv_pgs_subtitle`, `dvd_subtitle`, `vobsub`, `dvb_subtitle`) & **Text Subtitles** (`srt`, `subrip`, `ass`, `vtt`):
  - In Matroska / WebM output containers (`-f matroska`), all subtitle streams are stream-copied (`-c:s copy`), except `mov_text` which is converted to `srt`.

---

## 2. Container & Extension Rules

1. **No `.mp4` Target Rule**: No media is ever transcoded to `.mp4`.
2. **`.webm` Files Scanned**: `.webm` files are scanned and probed with `ffprobe` like all other formats.
3. **Container Conversion Matrix**:
   - **Source `.webm`**: If transcoding is required $\rightarrow$ Transcoded to **`.mkv`** (`<basename>.mkv`).
   - **Source `.mkv`**: If transcoding is required $\rightarrow$ Transcoded to **`.webm`** (`<basename>.webm`).
   - **Source `.mp4` & All Other Video Formats (`.avi`, `.mov`, `.flv`, `.wmv`, `.ts`, etc.)**: If transcoding is required $\rightarrow$ Transcoded to **`.webm`** (`<basename>.webm`).
   - **Standalone Audio Files (`.mp3`, `.m4a`, `.wav`, `.flac`, etc.)**: Transcoded to **`.opus`** (`<basename>.opus`).
   - **Files with Proper Codecs**: Ignored/Skipped and left untouched in original container as-is.

---

## 3. Operational Mechanics & Concurrency

### A. Instant Conversion Pipeline & 4-Worker Concurrent Probing
- **Direct Pipeline**: Conversion starts immediately during probing.
- **Concurrent Probing**: Executes `ffprobe` on candidates using **4 parallel workers** simultaneously.
- **Probing Display**: Live status: `[SLOTS] V: Idle | A1: Idle | ... | PROBING: X/Y (Z.Z%)`. Replaced with `ETA: #d #h #m` once probing completes.

### B. Error Tolerance & Failure Statistics Reporting
- **Non-Stop Execution**: Individual FFmpeg job errors do NOT stop the batch scheduler.
- **On Failure**:
  - The failure error message is dumped to the console on a new line (`[FAILURE - Slot X] Transcoding failed for "...": error`).
  - Incomplete output file is automatically deleted.
  - The scheduler continues processing all remaining files in the queue.
- **Final Report**: Reports total completed jobs and total failed jobs in the final summary report (`Total Completed : N`, `Total Failed : N`).

### C. Automatic Leftover Conversion Cleanup
- Unlinks leftover partial conversion files (`.webm`, `.mp4`, `.opus`) from prior interrupted runs **ONLY when the original untranscoded source file still exists AND the leftover file size is strictly smaller than the original**.

### D. Parallel Concurrency Scheduler & 15-Minute Staged-Interval Complexity-Weighted ETA Formula
- Live-updating overwriting single-line status:
  - Prior to 15 minutes of established data (marked with `*`):
    `[SLOTS] V: 45.2% (3.8x) | A1: 82.1% (110x) | A2: 14.5% (135x) | A3: Idle | A4: Idle | ETA: 1d 02h 15m*`
  - Once 15 minutes of data is established:
    `[SLOTS] V: 45.2% (3.8x) | A1: 82.1% (110x) | A2: 14.5% (135x) | A3: Idle | A4: Idle | ETA: 1d 02h 15m`
- **15-Minute Target Rolling Window with Progressive Staged Intervals & 15-Second History Buckets (`resolveEtaIntervalState` & `RollingSpeedTracker`)**:
  - Generates immediate ETA results right from startup with an asterisk (`*`) indicating that a full 15 minutes of transcoding data has not yet been established.
  - **15-Second Interval History Store**: Stores up to **60 fifteen-second history buckets** (`MAX_ETA_HISTORY_BUCKETS = 60` $\times$ `ETA_HISTORY_BUCKET_MS = 15000` = `15 minutes`), plus fine-grained samples for the initial `< 15s` startup phase (`immediate`, `2s`, `5s`).
  - **Until 2 minutes (`120s`) is established**: Rolls interval calculations through **2 seconds, 5 seconds, 15 seconds (1 bucket), 30 seconds (2 buckets), and 45 seconds (3 buckets)** (`SUB_TWO_MIN_INTERVALS_MS`).
  - **From 2 minutes until 15 minutes (`900s`) is established**: Rolls interval calculations through **2 minutes (8 buckets), 5 minutes (20 buckets), 8 minutes (32 buckets), and 12 minutes (48 buckets)** (`SUB_FIFTEEN_MIN_INTERVALS_MS`).
  - **Once 15 minutes (`900s`) is established**: Uses the full **15-minute** (`FULL_FIFTEEN_MIN_INTERVAL_MS` = **60 buckets of 15s**) rolling history window and removes the `*` indicator.
  - **15-Second ETA Update Cadence**: Once **15 seconds or more** of data has been fetched (`>= 15s`), the ETA updates strictly **once every 15 seconds** (as each 15-second history bucket completes) based on the stored history buckets for the active interval step. When 15 minutes of data has been stored, the ETA updates once every 15 seconds using the last 15 minutes (60 fifteen-second intervals) of history data.
- **Multi-Pass Progress Unification & FFmpeg Synchronization (`MultiPassProgressNormalizer`)**:
  - Passes `-stats_period 0.5`, `-max_muxing_queue_size 1024`, and `-muxing_queue_data_threshold 4194304` (4 MB) to FFmpeg so fast stream-copied tracks cannot buffer 50 MB ahead of encoded streams.
  - Cross-checks FFmpeg's `out_time` and `speed` (`#x`) against actual encoded video `frame` counts (`frame / nbFrames`), encoder `fps` (`fps / videoFps`), and complexity-expected speed $S_{\text{expected}}$.
  - When a fast stream pass (e.g. subtitles or stream-copied audio/video) surges ahead during Pass 1 and then resets/decreases for a 2nd or 3rd pass, `MultiPassProgressNormalizer` weights each pass by its inverse-speed time share ($w_{\text{fast}} = \frac{S_{\text{expected}}}{S_{\text{fast}} + S_{\text{expected}}}$) and joins all passes into a single monotonic $0\% \to 100\%$ percentage and validated `#x` speed.
- **Dual Speed (`#x`) + Percentage-Delta Over Time Tracking (`RollingSpeedTracker`)**:
  - Tracks both the difference in unified percentage between updates over wall-clock time ($\Delta P = P_k - P_{k-1}$ over $\Delta t = t_k - t_{k-1}$) and the validated `#x` speed, cross-checking implied percentage speed $S_{\Delta P} = D \cdot \frac{\Delta P / 100}{\Delta t}$ against `#x` speed to damp any residual spike.
  - Multiplies progress and speed by the current job's complexity weight $W_{\text{current}}$ to measure the real complexity throughput rate $R_W = \frac{\sum_{k \in \text{Interval}} \Delta W_k}{\sum_{k \in \text{Interval}} \Delta t_k}$ across the active staged interval (`2s` $\to$ `5s` $\to$ `15s` $\to$ `30s` $\to$ `45s` $\to$ `2m` $\to$ `5m` $\to$ `8m` $\to$ `12m` $\to$ `15m`).
- **Comprehensive Video Complexity Weight Formula (`getVideoTranscodeComplexity` & `getVideoTranscodeWorkload`)**:
  - Calculates video complexity workload units $W_{\text{video}} = D_{\text{sec}} \times C_{\text{video}}$ based on:
    - **Media Duration** ($D_{\text{sec}}$)
    - **Normalized Resolution Factor** relative to 1080p Full HD ($\max(0.15, 0.12 + 0.88 \times \frac{\text{width} \times \text{height}}{1920 \times 1080})$)
    - **Frame Rate Factor** relative to 30 fps ($0.15 + 0.85 \times \frac{\text{fps}}{30}$)
    - **SDR vs HDR & 10-bit Color Space Factor** ($1.45\times$ for 10-bit HDR hardware encode, $1.35\times$ for 10-bit HDR $\rightarrow$ SDR conversion, $1.25\times$ for 10-bit SDR, $1.00\times$ for 8-bit SDR)
    - **Source Video Codec Decoding Factor** (`av1`: $1.15\times$, `vp9`/`hevc`: $1.08\times$, `vp8`/`vc1`: $1.02\times$, `h264`: $1.00\times$, legacy: $0.92\times$)
    - **Multi-Track Count & Per-Track Complexity** (secondary video streams, transcoded vs copied audio tracks weighted by target encoder `libopus` vs `eac3`, channel count, 7.1 $\rightarrow$ 5.1 `pan` downmix filter, lossless vs lossy decode, image vs text subtitle tracks, attachments, and Matroska multi-track interleaving multiplier $1 + 0.012 \times \max(0, N_{\text{tracks}} - 2)$)
- **Audio-Only Complexity Weight & 4-Slot Parallel FIFO Simulation (`getAudioTranscodeWeight` & `getAudioTranscodeWorkload`)**:
  - Weights each audio-only job by its audio tracks (encoder type, channel count, 5.1 downmix filter, lossless decode), stream-copied video I/O overhead (resolution & HDR vs SDR), and subtitle/attachment tracks, then simulates the 4 parallel audio slots in FIFO order against all queued audio jobs.
- **Days formatting**: Formats ETA as `#d #h #m` if total duration exceeds 24 hours.

### E. Single Process-Wide SIGINT/SIGTERM Handler
- Registers exactly **1** global signal handler.
- Sends `SIGTERM` to active FFmpeg child processes, awaits exit to release OS file locks, and erases partial output files before exiting, while leaving original source files completely untouched.

---

## 4. Architecture & File Structure

```
convert/
├── AGENTS.md             # Developer & Agent instructions (this file)
├── README.md             # End-user documentation
├── index.html            # Optional NW.js desktop UI layout (no webpack)
├── package.json          # Node.js ES module & NW.js configuration ("npm start" & "npm run ui")
├── src/
│   ├── config.js         # Binary paths, candidate constants & codec hierarchy ranks
│   ├── hwprobe.js        # GPU hardware video encoder probing (4K resolution testing) & 10-bit HDR testing
│   ├── index.js          # CLI entry point, hardware probing & quality prompt
│   ├── probe.js          # FFprobe stream, resolution & HDR color metadata extraction
│   ├── scanner.js        # 2-Phase scanner, container conversion rules & leftover cleanup
│   ├── scheduler.js      # Parallel batch queue scheduler, workload-aware ETA calculation & 15-min speed tracker
│   ├── transcoder.js     # Managed FFmpeg process spawner, multi-vendor HW flags & SIGINT manager
│   ├── ui.js             # NW.js desktop interface controller (immediate directory browser, progress bar, ETA & dual queue lists)
│   └── utils.js          # Formatting helpers, time utils, Opus/EAC3 bitrate calculation algorithm
```

---

## 5. Executable Configuration

Primary binaries:
- `C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffmpeg.exe`
- `C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffprobe.exe`
*(Fallback to system `PATH` if Chocolatey paths do not exist).*
