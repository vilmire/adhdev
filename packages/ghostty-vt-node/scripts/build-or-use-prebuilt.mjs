import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const outputDir = path.join(packageDir, 'build', 'Release');
const outputFile = path.join(outputDir, 'ghostty_vt_node.node');
const triplet = `${process.platform}-${process.arch}-node${process.versions.modules}`;

function candidatePrebuiltPaths() {
  const candidates = [];
  const explicitDir = process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR?.trim();
  if (explicitDir) {
    candidates.push(path.join(explicitDir, triplet, 'ghostty_vt_node.node'));
    candidates.push(path.join(explicitDir, 'ghostty_vt_node.node'));
  }
  candidates.push(path.join(packageDir, 'prebuilt', triplet, 'ghostty_vt_node.node'));
  return candidates;
}

function installPrebuiltIfPresent() {
  for (const candidate of candidatePrebuiltPaths()) {
    if (!fs.existsSync(candidate)) continue;
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(candidate, outputFile);
    console.log(`[ghostty-vt-node] using prebuilt native binding from ${candidate}`);
    return true;
  }
  return false;
}

if (!installPrebuiltIfPresent() && process.env.ADHDEV_SKIP_GHOSTTY_VT_BUILD === '1') {
  console.log(`[ghostty-vt-node] skipping native build for ${triplet} (ADHDEV_SKIP_GHOSTTY_VT_BUILD=1)`);
  process.exit(0);
}

if (installPrebuiltIfPresent()) {
  process.exit(0);
}

const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const args = isWindows
  ? ['/d', '/s', '/c', 'npm exec -- cmake-js compile']
  : ['exec', '--', 'cmake-js', 'compile'];
console.log(`[ghostty-vt-node] compiling ${triplet} via ${command} ${args.join(' ')}`);
const result = spawnSync(command, args, {
  cwd: packageDir,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[ghostty-vt-node] failed to launch native build for ${triplet}:`, result.error);
}

process.exit(result.status ?? 1);
