import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * scripts/check-quota-reserve-single-source.mjs — the retired per-mesh /
 * per-consumer threshold names must not reappear outside quota/quota-reserve.ts.
 * Includes the gate checklist's NEGATIVE CONTROL: a planted reference makes the
 * gate fail, and the scanned-file count is asserted so the scan can't go empty.
 */
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/check-quota-reserve-single-source.mjs');
const run = (args: string[] = []) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function plant(source: string, file = 'planted.ts'): string {
    const root = mkdtempSync(join(tmpdir(), 'qr-gate-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', file), source);
    return join(root, 'src');
}

describe('check-quota-reserve-single-source', () => {
    it('passes on the real tree and reports a plausible scanned-file count', () => {
        const out = run();
        expect(out.status, out.stdout + out.stderr).toBe(0);
        const scanned = Number(/scanned (\d+) source files/.exec(out.stdout)?.[1]);
        expect(scanned).toBeGreaterThan(500);
    });

    it('NEGATIVE CONTROL: fails when a retired name reappears in a scanned source file', () => {
        for (const name of ['sessionMinRemainingPercent', 'weeklyMinRemainingPercent', 'sessionResetImminentMs', 'minQuotaRemainingPct']) {
            const out = run([plant(`export const x = { ${name}: 10 }\n`)]);
            expect(out.status, name).toBe(1);
            expect(out.stderr).toContain(name);
        }
    });

    it('honours the explicit escape hatch and ignores unrelated code', () => {
        expect(run([plant('const x = 1 // routingSessionMinPercent is fine\n')]).status).toBe(0);
        expect(run([plant('const a = { sessionMinRemainingPercent: 1 } // quota-reserve-ok: wire fixture\n')]).status).toBe(0);
    });

    it('fails loudly on a missing extra scan root instead of silently scanning less', () => {
        expect(run([join(tmpdir(), 'qr-gate-does-not-exist')]).status).toBe(1);
    });
});
