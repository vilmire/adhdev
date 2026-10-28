/**
 * The CJS build of daemon-core (dist/index.js) has no `import.meta` — esbuild rewrites it
 * to `{}`. transfer-fs-native.ts once called `createRequire(import.meta.url)` at module
 * load, so `require('@adhdev/daemon-core')` threw ERR_INVALID_ARG_VALUE for every CJS
 * consumer, whether or not it ever transferred a file. Bundle the module both ways and
 * prove it loads AND still finds its native binding.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Inside the package (dist-like depth) so the module-relative native candidates resolve as in a real build.
const outDir = path.join(pkgDir, `.tmp-transfer-fs-cjs-${process.pid}`);

function bundle(format: 'cjs' | 'esm'): string {
  const outfile = path.join(outDir, format === 'cjs' ? 'tfs.cjs' : 'tfs.mjs');
  buildSync({
    entryPoints: [path.join(pkgDir, 'src/transfer-fs/transfer-fs-native.ts')],
    bundle: true,
    platform: 'node',
    format,
    outfile,
    logLevel: 'silent',
  });
  return outfile;
}

function run(code: string, cwd: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('transfer-fs native module under both module formats', () => {
  beforeAll(() => fs.mkdirSync(outDir, { recursive: true }));
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it('a CJS bundle loads without touching import.meta and finds the native binding', () => {
    const file = bundle('cjs');
    // Run from a cwd OUTSIDE the package so only the module-relative (__filename) candidates can match.
    const r = run(
      `import { createRequire } from 'node:module'; const m = createRequire(import.meta.url)(${JSON.stringify(file)}); console.log('API', m.getBindingInfo().apiLevel);`,
      outDir,
    );
    expect(r.out).not.toMatch(/ERR_INVALID_ARG_VALUE/);
    expect(r.out).toMatch(/^API \d+/m);
    expect(r.status).toBe(0);
  });

  it('an ESM bundle still loads and finds the native binding', () => {
    const file = bundle('esm');
    const r = run(`const m = await import(${JSON.stringify(file)}); console.log('API', m.getBindingInfo().apiLevel);`, outDir);
    expect(r.out).toMatch(/^API \d+/m);
    expect(r.status).toBe(0);
  });
});
