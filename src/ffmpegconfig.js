/**
 * Platform-specific FFmpeg & FFprobe location configuration.
 * When packaged via @nexustools/nwjsreleasepackager, this file is overridden per target
 * platform and architecture to point directly to the bundled platform binary in `bin/`.
 * During local development (`npm start` / `npm run ui`), `config.js` resolves the binary
 * for the active OS and CPU architecture from the `ffmpeg-static` and `ffprobe-static` npm packages.
 */
export const FFMPEG_CONFIG = {
  platform: null,
  arch: null,
  ffmpegRelativePath: null,
  ffprobeRelativePath: null
};
