#!/usr/bin/env node
/**
 * QUOTA-RESERVE single-source gate (design 2026-11-01-machine-quota-reserve §8).
 *
 * "How much quota to leave for the person" has exactly ONE home:
 * packages/daemon-core/src/quota/quota-reserve.ts (config.quotaReserve, resolved
 * by resolveQuotaReserve). Before it existed the same bar was written three
 * ways — per-mesh policy fields, a review-turn constant, and ad-hoc literals —
 * so one account's quota was judged by different numbers depending on who
 * asked. This gate fails when any of the retired names reappears in a source
 * file other than that module:
 *
 *   sessionMinRemainingPercent   (was mesh policy.quotaRouting)
 *   weeklyMinRemainingPercent    (was mesh policy.quotaRouting)
 *   sessionResetImminentMs       (was mesh policy.quotaRouting)
 *   minQuotaRemainingPct         (was REVIEW_TRIGGER_RULES)
 *
 * Scanned: every *.ts/*.tsx under packages/{daemon-core,mcp-server,mesh-shared,
 * web-core,daemon-standalone,web-standalone,session-host-*}/src, skipping
 * node_modules, dist and any `vendor` directory (generated bundles). Tests are
 * outside src and may name the retired fields (they assert the rejection).
 *
 * The scanned-file count is printed so a refactor that silently empties the
 * scan (moved roots) is visible, and the gate fails below MIN_FILES.
 *
 * Extra scan roots (e.g. the proprietary superproject's packages/web-cloud/src)
 * may be passed as CLI arguments or ADHDEV_QUOTA_RESERVE_SCAN_ROOTS
 * (path-delimiter separated); those paths are never hard-coded here because
 * this repo is published on its own.
 *
 * Escape hatch: append `// quota-reserve-ok: <why>` to a flagged line.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ossRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = join(ossRoot, 'packages', 'daemon-core', 'src', 'quota', 'quota-reserve.ts');
const RETIRED = /\b(sessionMinRemainingPercent|weeklyMinRemainingPercent|sessionResetImminentMs|minQuotaRemainingPct)\b/;
const MIN_FILES = 500;

const DEFAULT_ROOTS = [
  'daemon-core', 'mcp-server', 'mesh-shared', 'web-core', 'daemon-standalone', 'web-standalone',
  'session-host-core', 'session-host-daemon', 'terminal-mux-core', 'terminal-mux-control',
].map((p) => join(ossRoot, 'packages', p, 'src'));

const extraArgs = [...process.argv.slice(2), ...(process.env.ADHDEV_QUOTA_RESERVE_SCAN_ROOTS || '').split(delimiter)].filter(Boolean);
const extraRoots = extraArgs.map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)));
const missingExtra = extraRoots.filter((p) => !existsSync(p) || !statSync(p).isDirectory());
if (missingExtra.length) {
  console.error('quota-reserve gate: scan root(s) not found:');
  for (const p of missingExtra) console.error(`  ${p}`);
  process.exit(1);
}
const roots = [...DEFAULT_ROOTS.filter((p) => existsSync(p)), ...extraRoots];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'vendor') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

let scanned = 0;
const findings = [];
for (const root of roots) {
  for (const file of walk(root)) {
    scanned += 1;
    if (resolve(file) === ALLOWED) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const m = RETIRED.exec(line);
      if (m && !/quota-reserve-ok:/.test(line)) findings.push(`${relative(process.cwd(), file)}:${i + 1}  ${m[1]}  ${line.trim().slice(0, 120)}`);
    });
  }
}

const expectedMin = extraRoots.length ? 1 : MIN_FILES;
console.log(`quota-reserve single-source gate: scanned ${scanned} source files in ${roots.length} root(s)`);
if (scanned < expectedMin) {
  console.error(`FAIL: scanned only ${scanned} files (< ${expectedMin}) — scan roots moved? Update DEFAULT_ROOTS.`);
  process.exit(1);
}
if (findings.length) {
  console.error(`FAIL: ${findings.length} reference(s) to retired quota-threshold names outside quota/quota-reserve.ts:`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('Read the reserve through resolveQuotaReserve(); do not reintroduce per-mesh or per-consumer thresholds.');
  process.exit(1);
}
console.log('OK');
