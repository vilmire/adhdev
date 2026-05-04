import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const sourceRoot = path.resolve(packageDir, '..', 'session-host-daemon', 'dist');
const targetRoot = path.join(packageDir, 'vendor', 'session-host-daemon');

function copyRecursive(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

if (!fs.existsSync(sourceRoot)) {
  console.error(`session-host-daemon dist not found at ${sourceRoot}`);
  process.exit(1);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
copyRecursive(sourceRoot, targetRoot);
console.log(`vendored session-host-daemon dist -> ${targetRoot}`);

// ── MCP Server ──
const mcpSourceRoot = path.resolve(packageDir, '..', 'mcp-server', 'dist');
const mcpTargetRoot = path.join(packageDir, 'vendor', 'mcp-server');

if (fs.existsSync(mcpSourceRoot)) {
  fs.rmSync(mcpTargetRoot, { recursive: true, force: true });
  copyRecursive(mcpSourceRoot, mcpTargetRoot);
  // Copy package.json for metadata
  const mcpPkgSrc = path.resolve(packageDir, '..', 'mcp-server', 'package.json');
  if (fs.existsSync(mcpPkgSrc)) {
    fs.copyFileSync(mcpPkgSrc, path.join(mcpTargetRoot, 'package.json'));
  }
  console.log(`vendored mcp-server dist -> ${mcpTargetRoot}`);
} else {
  console.warn(`⚠ mcp-server dist not found at ${mcpSourceRoot}, skipping`);
}
