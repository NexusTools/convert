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

### D. Parallel Concurrency Scheduler & Comprehensive ETA Formula
- Live-updating overwriting single-line status:
  `[SLOTS] V: 45.2% (3.8x) | A1: 82.1% (110x) | A2: 14.5% (135x) | A3: Idle | A4: Idle | ETA: 1d 02h 15m`
- **Rolling 2-Minute Moving Average**:
  - Transcoding speeds are sampled over a rolling 2-minute (120-second) window (`RollingSpeedTracker`).
- **Comprehensive Video Workload ETA Formula** (`getVideoTranscodeWorkload`):
  - Calculates video workload units based on:
    - **Media Duration** ($D_{\text{sec}}$)
    - **Normalized Resolution Factor** relative to 1080p Full HD ($\frac{\text{width} \times \text{height}}{1920 \times 1080}$)
    - **HDR 10-bit Color Space Factor** ($1.4\times$ multiplier for 10-bit HDR)
    - **Video Stream Count** ($N_{\text{video}}$)
- **Multi-Audio Track Weighting**:
  - Audio ETA factors in the number of audio streams requiring transcoding per video (`getAudioTranscodeWeight`).
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
├── package.json          # Node.js ES module configuration
├── src/
│   ├── config.js         # Binary paths, candidate constants & codec hierarchy ranks
│   ├── hwprobe.js        # GPU hardware video encoder probing (4K resolution testing) & 10-bit HDR testing
│   ├── index.js          # CLI entry point, hardware probing & quality prompt
│   ├── probe.js          # FFprobe stream, resolution & HDR color metadata extraction
│   ├── scanner.js        # 2-Phase scanner, container conversion rules & leftover cleanup
│   ├── scheduler.js      # Parallel batch queue scheduler, workload-aware ETA calculation & 2-min speed tracker
│   ├── transcoder.js     # Managed FFmpeg process spawner, multi-vendor HW flags & SIGINT manager
│   └── utils.js          # Formatting helpers, time utils, Opus/EAC3 bitrate calculation algorithm
```

---

## 5. Executable Configuration

Primary binaries:
- `C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffmpeg.exe`
- `C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffprobe.exe`
*(Fallback to system `PATH` if Chocolatey paths do not exist).*
