/**
 * Test temp-dir leak guard (mesh mission 8679dacb).
 *
 * ~36,000 fixture directories (~13 GB) accumulated in the OS temp dir because
 * hundreds of test files create dirs with `mkdtemp*` or `mkdirSync(join(tmpdir(),
 * 'prefix-<random>'))` and only some remove them (none on aborted paths). Instead
 * of editing every call site we wrap the creators ONCE per test process; every
 * directory this process brings into existence under the OS temp dir is recorded
 * and removed when the test file finishes:
 *
 *   - vitest packages: setup files call `removeTrackedTempDirs()` from `afterAll`
 *   - `node --test` packages: load this module with `node --import`; a
 *     `process.on('exit')` hook does the removal (each test FILE is its own process)
 *
 * What is tracked (exact paths only — never a tmpdir listing sweep, so concurrent
 * test processes cannot delete each other's directories):
 *   - the result of fs.mkdtempSync / fs.mkdtemp / fs.promises.mkdtemp
 *   - the top-level `<tmpdir>/<name>` directory brought into existence by
 *     fs.mkdirSync / fs.mkdir / fs.promises.mkdir, but only when `<name>` looks
 *     randomised (see UNIQUE_NAME). A fixed shared name could be in concurrent
 *     use by another test process, so it is left alone.
 *
 * Tests that spawn child processes must still clean what the CHILD creates (or
 * hand the child a directory the parent made — that one is tracked here).
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const fs = createRequire(import.meta.url)('node:fs');
const FLAG = Symbol.for('adhdev.testTmpLeakGuard');
const CREATED_KEY = Symbol.for('adhdev.testTmpLeakGuard.created');
const created = (globalThis[CREATED_KEY] ??= new Set());

// Last `-`/`_`/`.` token of >=6 alphanumerics that is not a plain lowercase word,
// e.g. `adhdev-mesh-gc-test-aa41ecce`, `adhdev-daemon-core-test-config-2SQodk`,
// `foo-1730000000000`. Plain words (`-fixtures`) are treated as shared names.
const UNIQUE_NAME = /[-_.](?=[A-Za-z0-9]*(?:\d|[A-Z]))[A-Za-z0-9]{6,}$/;

// Optional run-scoped manifest (`ADHDEV_TEST_TMP_MANIFEST`, exported by a runner's
// global setup): every tracked path is also appended to it so the runner can sweep
// what workers could not (a worker killed mid-file, a file that failed to load or was
// skipped never runs its `afterAll`, and worker `exit` events do not fire).
const MANIFEST = process.env.ADHDEV_TEST_TMP_MANIFEST;
const track = (abs) => {
  if (created.has(abs)) return;
  created.add(abs);
  if (MANIFEST) { try { fs.appendFileSync(MANIFEST, abs + '\n'); } catch { /* best effort */ } }
};

// Shape of a name a tracker/mkdtemp produced: a trailing run of >=6 alphanumerics
// after a separator (or the whole name, for mkdtemp with an empty prefix).
const SWEEP_NAME = /(?:^|[-_.])[A-Za-z0-9]{6,}$/;

const isSymlink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const tmpRoots = () => {
  const roots = new Set([path.resolve(os.tmpdir())]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* ignore */ }
  return roots;
};

/**
 * Safety predicate for the RUN-LEVEL sweep, which deletes paths read from a file:
 * the entry must be absolute, a DIRECT child of the temp dir (either spelling —
 * macOS /var vs /private/var), have a randomised-looking basename, and not be a
 * symlink. Returns null when safe, else a short reason.
 */
export function unsafeSweepReason(entry) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) return 'not absolute';
  const abs = path.resolve(entry);
  if (!([...tmpRoots()].some((r) => path.dirname(abs) === r))) return 'not a direct child of the temp dir';
  if (!SWEEP_NAME.test(path.basename(abs))) return 'name is not randomised';
  if (isSymlink(abs)) return 'is a symlink';
  return null;
}

/**
 * Runner-side sweep: remove every SAFE path listed in `manifestPath` (see
 * unsafeSweepReason; unsafe lines are skipped with a warning) and the manifest
 * itself. The manifest must be a regular file, not a symlink. Returns how many
 * listed directories still existed (i.e. leaked past the in-process cleanup).
 */
export function sweepTempManifest(manifestPath) {
  let leaked = 0;
  let lines = [];
  try {
    const st = fs.lstatSync(manifestPath);
    if (!st.isFile()) throw new Error('manifest is not a regular file');
    lines = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  } catch { /* none */ }
  for (const dir of new Set(lines)) {
    const why = unsafeSweepReason(dir);
    if (why) { console.warn(`[tmp-leak-guard] skipping manifest entry ${JSON.stringify(dir)}: ${why}`); continue; }
    try { if (fs.existsSync(dir)) leaked += 1; fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
  try { if (!isSymlink(manifestPath)) fs.rmSync(manifestPath, { force: true }); } catch { /* ignore */ }
  return leaked;
}

/** Remove every tracked dir now (vitest setup files call this from `afterAll`). */
export function removeTrackedTempDirs() {
  for (const dir of created) {
    // In-process entries were created by this process, but still never follow a
    // symlink swapped in later or touch anything outside the temp dir.
    const abs = path.resolve(dir);
    if (![...tmpRoots()].some((r) => abs.startsWith(r + path.sep)) || isSymlink(abs)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
  // Entries are KEPT: late writers (store close, flush timers) can re-create a
  // directory after this ran; the process-exit hook removes it a second time.
}

if (!globalThis[FLAG]) {
  globalThis[FLAG] = true;
  const roots = new Set([path.resolve(os.tmpdir())]);
  try { roots.add(fs.realpathSync(os.tmpdir())); } catch { /* ignore */ }

  /** Absolute path if `p` lies under the temp root, plus the root it lies under. */
  const under = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL)) return null;
    let abs;
    try { abs = path.resolve(p instanceof URL ? p.pathname : p); } catch { return null; }
    for (const r of roots) if (abs.startsWith(r + path.sep)) return { abs, root: r };
    return null;
  };
  const trackResult = (p) => { const u = under(p); if (u) track(u.abs); };
  /** `<root>/<first segment>` of a path under tmp, when that name looks unique. */
  const topLevel = (p) => {
    const u = under(p);
    if (!u) return null;
    const first = u.abs.slice(u.root.length + 1).split(path.sep)[0];
    return first && UNIQUE_NAME.test(first) ? path.join(u.root, first) : null;
  };

  const o = {
    mkdtempSync: fs.mkdtempSync, mkdtemp: fs.mkdtemp, pmkdtemp: fs.promises.mkdtemp,
    mkdirSync: fs.mkdirSync, mkdir: fs.mkdir, pmkdir: fs.promises.mkdir,
  };

  fs.mkdtempSync = function (...a) { const r = o.mkdtempSync.apply(this, a); trackResult(r); return r; };
  fs.mkdtemp = function (...a) {
    const cb = a[a.length - 1];
    if (typeof cb === 'function') {
      a[a.length - 1] = (err, dir, ...rest) => { if (!err) trackResult(dir); return cb(err, dir, ...rest); };
    }
    return o.mkdtemp.apply(this, a);
  };
  fs.promises.mkdtemp = async function (...a) { const r = await o.pmkdtemp.apply(this, a); trackResult(r); return r; };

  fs.mkdirSync = function (p, ...rest) {
    const top = topLevel(p);
    const existed = top ? fs.existsSync(top) : true;
    const r = o.mkdirSync.call(this, p, ...rest);
    if (top && !existed) track(top);
    return r;
  };
  fs.mkdir = function (p, ...rest) {
    const top = topLevel(p);
    const existed = top ? fs.existsSync(top) : true;
    const cb = rest[rest.length - 1];
    if (top && !existed && typeof cb === 'function') {
      rest[rest.length - 1] = (err, ...r) => { if (!err) track(top); return cb(err, ...r); };
    }
    return o.mkdir.call(this, p, ...rest);
  };
  fs.promises.mkdir = async function (p, ...rest) {
    const top = topLevel(p);
    const existed = top ? fs.existsSync(top) : true;
    const r = await o.pmkdir.call(this, p, ...rest);
    if (top && !existed) track(top);
    return r;
  };

  // Re-sync so `import { mkdtempSync } from 'node:fs'` named bindings see the wrappers.
  syncBuiltinESMExports();
  process.on('exit', removeTrackedTempDirs);
}
