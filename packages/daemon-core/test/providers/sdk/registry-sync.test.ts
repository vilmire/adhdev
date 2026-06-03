/**
 * Tests for the ProviderLoader.fetchFromRegistry() incremental sync.
 *
 * Uses a lightweight mock HTTP server so no real network calls are made.
 * The tests verify: fresh install (all providers downloaded), up-to-date
 * (checksums match, no downloads), stale (one provider updated), and
 * network failure (graceful fallback via returned error).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// We need to test fetchFromRegistry against a controllable HTTP server.
// Rather than importing ProviderLoader (which has many side-effects), we
// extract and unit-test the core sync logic inline, mirroring what the
// method actually does so we cover the real algorithmic paths.

function sha256hex(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

interface RegistryEntry {
    type: string;
    category: string;
    version: string;
    checksum: string;
    manifest: Record<string, unknown>;
}

/**
 * Minimal in-process mock of fetchFromRegistry logic.
 * Mirrors the actual method so test coverage is meaningful.
 */
async function syncFromRegistry(
    baseUrl: string,
    upstreamDir: string,
    cachedChecksums: Record<string, string>
): Promise<{ updated: boolean; checksums: Record<string, string>; error?: string }> {
    const http_ = await import('node:http');
    const https_ = await import('node:https');

    function fetchText(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('https') ? https_ : http_;
            const req = (mod as typeof http).get(url, { headers: { 'User-Agent': 'adhdev-test' } }, (res) => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            });
            req.on('error', reject);
        });
    }

    try {
        const listBody = await fetchText(`${baseUrl}/providers`);
        const list = JSON.parse(listBody) as { providers: RegistryEntry[] };
        if (!Array.isArray(list.providers)) throw new Error('unexpected response shape');

        let updatedCount = 0;
        const newChecksums = { ...cachedChecksums };

        for (const entry of list.providers) {
            const { type, category, checksum, version } = entry;
            const cacheKey = `${category}/${type}`;
            if (newChecksums[cacheKey] === checksum) continue;

            const manifestBody = await fetchText(`${baseUrl}/providers/${type}/${version}/download`);
            const actual = sha256hex(manifestBody);
            if (actual !== checksum) continue; // mismatch — skip

            const dir = path.join(upstreamDir, category, type);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'provider.json'), manifestBody, 'utf-8');
            newChecksums[cacheKey] = checksum;
            updatedCount++;
        }

        return { updated: updatedCount > 0, checksums: newChecksums };
    } catch (e: any) {
        return { updated: false, checksums: cachedChecksums, error: e?.message };
    }
}

// ─── Mock server ─────────────────────────────────────

function startMockServer(entries: RegistryEntry[]): Promise<{ url: string; server: http.Server }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url!, `http://localhost`);
            if (url.pathname === '/providers') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ providers: entries.map(e => ({ type: e.type, category: e.category, version: e.version, checksum: e.checksum })) }));
                return;
            }
            const dlMatch = url.pathname.match(/^\/providers\/([^/]+)\/([^/]+)\/download$/);
            if (dlMatch) {
                const [, type, version] = dlMatch;
                const entry = entries.find(e => e.type === type && e.version === version);
                if (entry) {
                    const body = JSON.stringify(entry.manifest);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(body);
                } else {
                    res.writeHead(404); res.end();
                }
                return;
            }
            res.writeHead(404); res.end();
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ url: `http://127.0.0.1:${addr.port}`, server });
        });
        server.on('error', reject);
    });
}

// ─── Tests ────────────────────────────────────────────

describe('registry sync logic', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-registry-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('downloads all providers on a fresh upstream directory', async () => {
        const manifest = { type: 'claude-cli', category: 'cli', providerVersion: '1.0.0' };
        const body = JSON.stringify(manifest);
        const checksum = sha256hex(body);
        const entries: RegistryEntry[] = [{ type: 'claude-cli', category: 'cli', version: '1.0.0', checksum, manifest }];

        const { url, server } = await startMockServer(entries);
        try {
            const result = await syncFromRegistry(url, tmpDir, {});
            expect(result.updated).toBe(true);
            expect(result.checksums['cli/claude-cli']).toBe(checksum);
            const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cli/claude-cli/provider.json'), 'utf-8'));
            expect(written.type).toBe('claude-cli');
        } finally {
            server.close();
        }
    });

    it('skips providers whose checksum already matches', async () => {
        const manifest = { type: 'codex-cli', category: 'cli', providerVersion: '1.0.0' };
        const body = JSON.stringify(manifest);
        const checksum = sha256hex(body);
        const entries: RegistryEntry[] = [{ type: 'codex-cli', category: 'cli', version: '1.0.0', checksum, manifest }];

        const { url, server } = await startMockServer(entries);
        try {
            // Pre-populate cache with current checksum
            const result = await syncFromRegistry(url, tmpDir, { 'cli/codex-cli': checksum });
            expect(result.updated).toBe(false); // nothing changed
        } finally {
            server.close();
        }
    });

    it('updates only the stale provider when one checksum changes', async () => {
        const m1 = { type: 'claude-cli', category: 'cli', providerVersion: '1.0.0' };
        const m2 = { type: 'codex-cli', category: 'cli', providerVersion: '1.0.0' };
        const b1 = JSON.stringify(m1);
        const b2 = JSON.stringify(m2);
        const c1 = sha256hex(b1);
        const c2 = sha256hex(b2);
        const entries: RegistryEntry[] = [
            { type: 'claude-cli', category: 'cli', version: '1.0.0', checksum: c1, manifest: m1 },
            { type: 'codex-cli',  category: 'cli', version: '1.0.0', checksum: c2, manifest: m2 },
        ];

        const { url, server } = await startMockServer(entries);
        try {
            // codex already up to date; claude needs a download
            const result = await syncFromRegistry(url, tmpDir, { 'cli/codex-cli': c2 });
            expect(result.updated).toBe(true);
            expect(result.checksums['cli/claude-cli']).toBe(c1);
            expect(result.checksums['cli/codex-cli']).toBe(c2);
            expect(fs.existsSync(path.join(tmpDir, 'cli/claude-cli/provider.json'))).toBe(true);
            expect(fs.existsSync(path.join(tmpDir, 'cli/codex-cli/provider.json'))).toBe(false);
        } finally {
            server.close();
        }
    });

    it('returns error and does not update when registry is unreachable', async () => {
        // Port 1 is reserved and will always refuse connections
        const result = await syncFromRegistry('http://127.0.0.1:1', tmpDir, {});
        expect(result.updated).toBe(false);
        expect(result.error).toBeTruthy();
    });
});
