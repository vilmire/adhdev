import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withAccountEmail } from '../../src/quota/fetchers/codex.js';
import { buildCloudStatusReportPayload } from '../../src/status/reporter.js';

// ACCOUNT-EMAIL SERVER BOUNDARY.
//
// `metadata.accountEmail` is personal data. It rides MeshNodeFacts because that
// bundle is P2P/local only. The status path to the server is guarded by four
// independent ALLOW-LISTS (CLAUDE.md "Server content boundary"), and the whole
// point of an allow-list is that a field added upstream does not silently leak.
//
// These tests are the tripwire for that promise: if anyone teaches a
// server-bound layer about this field, they turn red. Do not "fix" a failure
// here by adding the field to the allow-list — the failure IS the design.

const REPO_ROOT = join(import.meta.dirname, '../../../../..');

function readSource(relativePath: string): string {
    return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

/** The four server-side allow-list layers plus the daemon-side projection. */
const SERVER_BOUND_SOURCES: ReadonlyArray<{ label: string; path: string }> = [
    { label: 'daemon projection (buildCloudStatusReportPayload)', path: 'oss/packages/daemon-core/src/status/reporter.ts' },
    { label: 'DO ingest (sanitizeSessionEntry)', path: 'packages/server/src/durable-objects/daemon-status.ts' },
    { label: 'DO broadcast/persist (toCompactSession, toPersistedEntry)', path: 'packages/server/src/durable-objects/UserSession.ts' },
    { label: 'automation API (toPublicSession)', path: 'packages/server/src/routes/shortcuts.ts' },
];

describe('accountEmail never crosses the server boundary', () => {
    it('appears in none of the server-bound layers', () => {
        for (const { label, path } of SERVER_BOUND_SOURCES) {
            const source = readSource(path);
            expect(source, `${label} (${path}) must not mention accountEmail`).not.toContain('accountEmail');
            // The daemon-side projection additionally must not learn about quota
            // at all — quota reaching it is the step that would put this field
            // one allow-list edit away from the wire.
            if (path.endsWith('status/reporter.ts')) {
                expect(source, 'the cloud status projection must not carry quota').not.toContain('quota');
            }
        }
    });

    it('RoutingSessionEntry has no quota or account field', () => {
        // The wire type for the status path. If quota is never on this type, the
        // email cannot ride it even if a projection tried to send one.
        const shared = readSource('oss/packages/daemon-core/src/shared-types.ts');
        const start = shared.indexOf('interface RoutingSessionEntry');
        expect(start).toBeGreaterThan(-1);
        const body = shared.slice(start, shared.indexOf('}', start));
        expect(body).not.toContain('quota');
        expect(body).not.toContain('accountEmail');
        expect(body).not.toContain('email');
    });

    it('the built cloud payload carries no account data even when quota is present', () => {
        // Behavioural counterpart to the source scans: feed a session that
        // carries quota + an email and assert neither survives the projection.
        const payload = buildCloudStatusReportPayload(
            [{
                id: 'sess_1',
                parentId: null,
                providerType: 'codex-cli',
                providerName: 'Codex CLI',
                kind: 'cli',
                transport: 'pty',
                status: 'idle',
                workspace: '/repo',
                // Deliberately smuggled in — the projection must drop them.
                quota: { 'codex-cli': { metadata: { accountEmail: 'someone@example.com' } } },
                metadata: { accountEmail: 'someone@example.com' },
            } as any],
            undefined,
            Date.now(),
        );

        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain('accountEmail');
        expect(serialized).not.toContain('someone@example.com');
        expect(serialized).not.toContain('quota');
    });

    it('get_machine_runtime_stats (the quota carrier) is not a server route', () => {
        // Quota reaches the dashboard over P2P/local command paths. If this
        // command ever appears in the Worker, quota — and this email — would be
        // travelling through the server.
        for (const path of [
            'packages/server/src/durable-objects/daemon-status.ts',
            'packages/server/src/durable-objects/UserSession.ts',
            'packages/server/src/routes/shortcuts.ts',
        ]) {
            expect(readSource(path)).not.toContain('get_machine_runtime_stats');
        }
    });
});

describe('withAccountEmail — minimum viable disclosure', () => {
    const base = {
        provider: 'codex-cli' as const,
        session: null,
        weekly: null,
        updatedAt: 1,
        error: null,
        status: 'ok' as const,
        metadata: { source: 'app-server' },
    };

    it('takes ONLY the email from the account payload', () => {
        const out = withAccountEmail(base, {
            account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus', id: 'acct_123', sub: 'sub_456' },
            requiresOpenaiAuth: true,
        });
        expect(out.metadata?.accountEmail).toBe('user@example.com');
        // Nothing else from the account object is copied — no id, no sub, no token.
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain('acct_123');
        expect(serialized).not.toContain('sub_456');
        expect(serialized).not.toContain('requiresOpenaiAuth');
    });

    it('leaves the snapshot untouched when no account is reported', () => {
        // Providers that expose no account (Claude Code) must produce no empty
        // placeholder — the field is simply absent.
        expect(withAccountEmail(base, undefined).metadata?.accountEmail).toBeUndefined();
        expect(withAccountEmail(base, {}).metadata?.accountEmail).toBeUndefined();
        expect(withAccountEmail(base, { account: {} }).metadata?.accountEmail).toBeUndefined();
        expect(withAccountEmail(base, { account: { email: '   ' } }).metadata?.accountEmail).toBeUndefined();
    });

    it('preserves the existing metadata (planType survives enrichment)', () => {
        const withPlan = { ...base, metadata: { source: 'app-server', planType: 'plus' } };
        const out = withAccountEmail(withPlan, { account: { email: 'user@example.com' } });
        expect(out.metadata?.planType).toBe('plus');
        expect(out.metadata?.source).toBe('app-server');
    });
});
