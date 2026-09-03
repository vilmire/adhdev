/**
 * ★ The transcript worker's OPFS storage does NOT require cross-origin
 * isolation. This file exists to keep that fact true, because believing the
 * opposite would be expensive in a very specific way.
 *
 * ── Why this matters ──────────────────────────────────────────────────────
 * `vitest.browser.config.ts` serves COOP:same-origin + COEP:require-corp, and
 * it is easy to read that as "the SAH pool VFS needs cross-origin isolation,
 * so the hosting document must send those headers too". It does not, and
 * `packages/web-cloud` MUST NOT send them:
 *
 *   - `web-cloud/index.html` loads Paddle.js, and `Paddle.Checkout.open({
 *     displayMode: 'overlay' })` mounts a cross-origin `buy.paddle.com`
 *     iframe. Nested cross-origin iframes must send their own COEP under BOTH
 *     `require-corp` and `credentialless`, and Paddle's does not — so
 *     enabling COEP at all breaks upgrades, i.e. breaks billing.
 *   - `require-corp` additionally breaks the Google Fonts stylesheet,
 *     Plausible's injected script, and OAuth avatar images, none of which
 *     send `Cross-Origin-Resource-Policy`.
 *
 * ── What actually gates the SAH pool VFS ──────────────────────────────────
 * Only `FileSystemFileHandle.createSyncAccessHandle`, which is
 * worker-scope-only but NOT isolation-gated. `SharedArrayBuffer` is the API
 * that requires isolation, and the SAH pool VFS does not use it. So the real
 * constraint on the transcript worker is "must run in a Worker" — already
 * satisfied by `transcript-worker-entry.ts` — not "must be cross-origin
 * isolated".
 *
 * ── Why a separate config ─────────────────────────────────────────────────
 * The property under test is the ABSENCE of a response header, so it cannot
 * be asserted from the isolated harness: `server.headers` is per-config.
 * `vitest.browser-unisolated.config.ts` serves this directory with no COOP/
 * COEP, reproducing web-cloud's real condition. The first assertion below
 * would fail immediately if that config ever grew the headers back, which is
 * the point — it pins the test's own premise rather than trusting it.
 */
import { describe, expect, it } from 'vitest';
import type { IsolationProbeResult } from './opfs-isolation-independence.worker.js';

async function probe(directory: string): Promise<IsolationProbeResult> {
    const worker = new Worker(new URL('./opfs-isolation-independence.worker.ts', import.meta.url), {
        type: 'module',
    });
    try {
        return await new Promise<IsolationProbeResult>((resolve, reject) => {
            worker.onmessage = (ev) => resolve(ev.data as IsolationProbeResult);
            worker.onerror = (ev) => reject(new Error(ev.message || 'probe worker failed'));
            worker.postMessage({ directory, dbFilename: 'isolation-probe.sqlite3' });
        });
    } finally {
        worker.terminate();
    }
}

describe('OPFS SAH pool VFS vs cross-origin isolation', () => {
    it('opens and round-trips a database with crossOriginIsolated=false and no SharedArrayBuffer', async () => {
        const directory = `.adhdev-isolation-probe/${Math.random().toString(36).slice(2)}`;
        const result = await probe(directory);

        expect(result.error).toBeUndefined();

        // The premise this whole file rests on: the page is genuinely NOT
        // isolated. If someone adds COOP/COEP to the unisolated config, these
        // two go red rather than silently making the test vacuous.
        expect(result.crossOriginIsolated).toBe(false);
        expect(result.hasSharedArrayBuffer).toBe(false);

        // The API that actually matters is present regardless of isolation.
        expect(result.hasCreateSyncAccessHandle).toBe(true);

        // Exercised, not merely feature-probed: a real write survived a real
        // read through the SAH pool VFS.
        expect(result.vfsUsable).toBe(true);
        expect(result.roundTrip).toEqual([42]);
    });
});
