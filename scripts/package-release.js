import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NwjsReleasePackager } from '@nexustools/nwjsreleasepackager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const TARGET_PLATFORM_BINARIES = [
  { nodePlatform: 'win32', arch: 'x64', exeName: 'ffmpeg.exe' },
  { nodePlatform: 'darwin', arch: 'x64', exeName: 'ffmpeg' },
  { nodePlatform: 'linux', arch: 'x64', exeName: 'ffmpeg' }
];

/**
 * Ensures the platform-specific `ffmpeg` binary from `ffmpeg-static` is downloaded
 * for every target OS/architecture before running the release packager.
 */
function ensurePlatformFfmpegBinaries() {
  const ffmpegStaticDir = path.join(projectDir, 'node_modules', 'ffmpeg-static');
  const installScript = path.join(ffmpegStaticDir, 'install.js');
  const defaultWinFfmpeg = path.join(ffmpegStaticDir, 'ffmpeg.exe');

  for (const target of TARGET_PLATFORM_BINARIES) {
    const destDir = path.join(ffmpegStaticDir, 'bin', target.nodePlatform, target.arch);
    const destFile = path.join(destDir, target.exeName);
    fs.mkdirSync(destDir, { recursive: true });

    if (fs.existsSync(destFile) && fs.statSync(destFile).size > 1024 * 1024) {
      console.log(`[ffmpeg-static] Verified ${target.nodePlatform}-${target.arch}: ${destFile}`);
      continue;
    }

    if (target.nodePlatform === 'win32' && target.arch === 'x64' && fs.existsSync(defaultWinFfmpeg)) {
      fs.copyFileSync(defaultWinFfmpeg, destFile);
      console.log(`[ffmpeg-static] Copied existing win32-x64 binary to ${destFile}`);
      continue;
    }

    console.log(`[ffmpeg-static] Downloading ${target.nodePlatform}-${target.arch} ffmpeg binary...`);
    execFileSync(process.execPath, [installScript], {
      cwd: ffmpegStaticDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_platform: target.nodePlatform,
        npm_config_arch: target.arch,
        FFMPEG_BIN: destFile
      }
    });
  }
}

async function main() {
  ensurePlatformFfmpegBinaries();

  const packager = new NwjsReleasePackager({
    projectDir,
    onProgress: (stage, detail) => {
      console.log(`[${stage}] ${detail}`);
    }
  });

  const result = await packager.packageAll();

  if (result.warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const w of result.warnings) {
      console.warn(`  - ${w}`);
    }
  }

  console.log(
    `\nPackaged ${result.productName} v${result.version} (NW.js v${result.nwVersion}) in ${result.durationMs}ms:`
  );
  for (const artifact of result.artifacts) {
    const mb = (artifact.sizeBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `  - [${artifact.format}] ${artifact.fileName} (${mb} MB) sha256:${artifact.sha256.slice(0, 16)}...`
    );
  }
}

main().catch((err) => {
  console.error('Packaging failed:', err);
  process.exit(1);
});
