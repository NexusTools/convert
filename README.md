# Video & Audio Batch Transcoder CLI

A Node.js command-line tool that scans a directory for video and standalone audio files, probes media codecs asynchronously, and selectively transcodes them using **GPU hardware acceleration** across all platforms (AMD AMF, NVIDIA NVENC, Intel QSV, Apple VideoToolbox, VAAPI, Vulkan) for video and **codec-aware audio encoding (`libopus` / `eac3`)** for audio, while preserving all subtitle streams.

## Features & Container Transcoding Rules

- **15-Minute Staged-Interval Multi-Pass ETA Formula with 15-Second History Buckets & Preliminary `*` Indicator**:
  - Generates immediate ETA results with an asterisk (`*`) (e.g., `ETA: 1d 02h 15m*`) until a full **15 minutes** of transcoding data has been established:
    - **15-Second Interval History Store**: Stores a rolling history of **15-second interval buckets** up to **15 minutes** (**60 buckets $\times$ 15s = 900s**), plus fine-grained samples for the initial `< 15s` startup steps (`2s`, `5s`).
    - **Until 2 minutes is established**: Rolls interval calculations through **2 seconds, 5 seconds, 15 seconds (1 bucket), 30 seconds (2 buckets), and 45 seconds (3 buckets)**.
    - **From 2 minutes until 15 minutes is established**: Rolls interval calculations through **2 minutes (8 buckets), 5 minutes (20 buckets), 8 minutes (32 buckets), and 12 minutes (48 buckets)**.
    - **Once 15 minutes is established**: Bases the ETA on the full **15-minute** rolling history (**60 buckets of 15s**) (`RollingSpeedTracker`) and removes the `*` indicator.
    - **15-Second ETA Update Cadence**: Once **15 seconds or more** of data has been fetched, the ETA updates **once every 15 seconds** using the stored 15-second history buckets for the active interval step (and once 15 minutes of data is stored, updates once every 15 seconds with the last 15 minutes of 15-second history intervals).
  - Passes `-stats_period 0.5`, `-max_muxing_queue_size 1024`, and `-muxing_queue_data_threshold 4194304` to FFmpeg and normalizes multi-pass/multi-stream progress via `MultiPassProgressNormalizer`.
  - Cross-checks FFmpeg's `out_time` and `#x` speed against actual encoded video `frame` counts, encoder `fps`, and expected complexity speed to detect when a fast first pass (e.g. subtitles or stream-copied tracks) increases too fast before resetting/decreasing for a 2nd or 3rd pass—joining all passes into a single monotonic $0\% \to 100\%$ percentage.
  - Combines **both the `#x` speed and the difference in percentage between updates over time** ($\Delta P / \Delta t$) against the complexity weight of the active transcode ($W_{\text{current}}$) and the remaining complexity weights of all queued items ($W_{\text{queued}}$).
  - Computes transcode complexity weights from **Media Duration**, **Resolution** (normalized to 1080p with fixed pipeline floor + pixel scaling), **Frame Rate** (normalized to 30 fps), **SDR vs 10-bit HDR Color Space** ($1.45\times$ for 10-bit HDR encode, $1.35\times$ for HDR $\rightarrow$ SDR conversion, $1.25\times$ for 10-bit SDR, $1.0\times$ for 8-bit SDR), **Source Video Codec**, and **Total Track Count & Per-Track Complexity** (video streams, transcoded vs copied audio tracks, `libopus` vs `eac3`, 5.1/7.1 downmixing, lossless decode, subtitles, and Matroska packet interleaving).
  - Formats ETA with days (`1d 02h 15m`) when total duration exceeds 24 hours.
- **4K UHD (3840x2160) Hardware Test Probing**:
  - Synthetic GPU hardware encoding tests run at 4K UHD resolution (`3840x2160`) so 10-bit HDR hardware encoding is reported supported ONLY if the GPU hardware driver supports 4K 10-bit HDR hardware encoding.
- **Error Tolerance & Failure Statistics Reporting**:
  - Individual FFmpeg job errors do NOT stop the batch scheduler. Failed jobs dump an error message, delete partial output files, and continue processing remaining items in the batch.
  - Final batch summary reports both `Total Completed` and `Total Failed` job counts.
- **Dynamic GPU Hardware Video Encoder Probing**:
  - Probes FFmpeg at startup for available GPU hardware encoders across all platforms (AMD AMF, NVIDIA NVENC, Intel QSV, Apple VideoToolbox, VAAPI, Vulkan) and verifies active GPU driver support with 0.2s synthetic test spawns.
  - Automatically selects the system's **most efficient verified hardware encoder**.
  - **Hardware-Only Enforced**: Throws a fatal error if no functional GPU hardware video encoder is present on the system.
- **5-Tier Codec Efficiency Hierarchy**:
  - `av1` (Rank 1) $>$ `vp9` (Rank 2) $>$ `vp8` (Rank 3) $>$ `hevc`/`h265` (Rank 4) $>$ `h264`/`avc` (Rank 5) $>$ Legacy/Others (Rank 99).
  - Any video using a codec **equally or more efficient** than the system's target codec is **stream-copied (`-c:v copy`)**. Any video using a less efficient codec is **transcoded** to the system target hardware encoder.
- **Target Codec Console Summary & Interactive Quality Prompt**:
  - Dumps the probed GPU hardware encoder details and planned target video codec to the console first.
  - Prompts the user for their target numeric quality parameter (default `24`), explaining that lower numbers yield higher visual quality and larger file sizes, while higher numbers yield lower visual quality and smaller file sizes.
- **Optical Audio Playback Limit for EAC3**:
  - EAC3 encoding bitrates are dynamically calculated and **strictly capped at 640 kbps** (`Math.min(640, kbps)`), adhering to the maximum bandwidth limit for optical audio (TOSLINK / S-PDIF) receivers and soundbars.
- **Standalone Audio File Conversion**:
  - Converts non-Opus standalone audio files (`.mp3`, `.m4a`, `.wav`, `.flac`, `.aac`, `.ogg`, `.wma`, `.aiff`, `.alac`, `.ape`) to **`.opus`**.
  - All standalone audio conversions are queued into the **Audio-Only Transcode Queue** (running up to 4 concurrent slots in parallel).
  - Deletes the original source audio file upon successful completion.
- **Codec-Aware Audio Bitrate Algorithm**:
  - **Lossless Sources** (`flac`, `alac`, `wav`, `pcm`, `ape`): Encoded with high-fidelity Opus (**256 kbps** stereo, **128 kbps** mono, **384 kbps** 5.1) or high-fidelity EAC3 (**640 kbps** max optical limit).
  - **Lossy Sources**: Calculates target Opus/EAC3 bitrate based on original bitrate and codec efficiency factors.
- **Instant Conversion Pipeline & 4 Parallel Probe Workers**:
  - Transcoding begins immediately as files are probed using **4 concurrent `ffprobe` workers in parallel**.
  - Probing progress is displayed directly on the live progress line: `PROBING: X/Y (Z.Z%)`, and is replaced with `ETA: #d #h #m` once probing finishes.
- **Parallel Queue Scheduler**:
  - **1 Concurrent Video Transcode Slot**: Hardware GPU encoding (`hevc_amf`, `av1_nvenc`, `av1_amf`, `hevc_qsv`, etc.).
  - **4 Concurrent Audio-Only Transcode Slots**: Fast parallel audio transcoding (`eac3` / `opus` / 5.1 downmixing / standalone `.opus`) while stream-copying video (`-c:v copy`).
- **Automatic Leftover Cleanup with Size Verification**:
  - Unlinks leftover partial conversion files (`.webm`, `.mp4`, `.opus`) from interrupted prior runs **ONLY when the original source file still exists AND the leftover file size is strictly smaller than the original**.
- **Multi-Slot Progress Display & Refined Banners**:
  - Live single-line overwriting progress: `[SLOTS] V: 45.2% (3.8x) | A1: 82.1% (110x) | A2: 14.5% (135x) | A3: Idle | A4: Idle | ETA: 1d 02h 15m`.
  - Job start banners format video/audio codec transitions using concise `->` arrows (e.g. `Video Codec : h264 -> h265 (hevc_amf)`).
- **Single Process-Wide SIGINT Handler**:
  - Captures `SIGINT` (CTRL+C) or job errors centrally, sends `SIGTERM` to all active FFmpeg processes, awaits process termination to release OS file locks, and erases partial output files before exiting, while leaving all original video/audio files completely untouched.
- **Original File Deletion**: Erases original source video files only after successful transcoding completion.

## Executable Configuration

By default, the application checks for FFmpeg/FFprobe at:
- `C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffmpeg.exe`
- `C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffprobe.exe`

If missing, it falls back to system `PATH`.

## Quick Start

### Prerequisites
- Node.js 18.0.0 or higher
- FFmpeg and FFprobe installed with GPU hardware video encoding support (AMF, NVENC, QSV, VideoToolbox, VAAPI, Vulkan)

### Usage

Run the transcoder via the command line or launch the optional NW.js desktop UI (without webpack):

```bash
# Launch the optional NW.js desktop UI (opens directory browser immediately)
npm run ui

# Scan and transcode media in the current directory (CLI)
npm start

# Scan and transcode media in a specific directory (CLI)
node src/index.js "C:\path\to\media"
```

### Developer / Agent Guide
For full developer specifications, design principles, and command references, see [AGENTS.md](file:///D:/AICore/workspace/convert/AGENTS.md).
