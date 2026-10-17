# Video & Audio Batch Transcoder CLI

A Node.js command-line tool that scans a directory for video and standalone audio files, probes media codecs asynchronously, and selectively transcodes them using **GPU hardware acceleration** across all platforms (AMD AMF, NVIDIA NVENC, Intel QSV, Apple VideoToolbox, VAAPI, Vulkan) for video and **codec-aware audio encoding (`libopus` / `eac3`)** for audio, while preserving all subtitle streams.

## Features & Container Transcoding Rules

- **Comprehensive Workload-Aware ETA Formula**:
  - Calculates video workload units based on **Media Duration**, **Resolution** (normalized to 1080p), **HDR 10-bit Color Space** ($1.4\times$ multiplier), and **Video Stream Count**.
  - Samples speeds over a rolling 2-minute (120-second) window (`RollingSpeedTracker`) to produce smooth, highly accurate ETA predictions.
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

Run the transcoder against any target directory (defaults to current directory if omitted):

```bash
# Scan and transcode media in the current directory
node src/index.js

# Scan and transcode media in a specific directory
node src/index.js "C:\path\to\media"
```

### Developer / Agent Guide
For full developer specifications, design principles, and command references, see [AGENTS.md](file:///D:/AICore/workspace/convert/AGENTS.md).
