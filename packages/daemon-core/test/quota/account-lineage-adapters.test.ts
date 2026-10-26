/**
 * Owning-CLI account lineage for claude-cli, codex-cli, cursor-cli and
 * antigravity-cli (grok/kimi live in their own suites). Synthetic fixtures
 * only: every reader is pointed at a temp dir, never the owner's home.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sameQuotaAccount, settleAccountQuota, UNKNOWN_ACCOUNT_LINEAGE, type QuotaAccountLineage } from '../../src/quota/account-lineage.js';
import { readCurrentQuotaAccountLineage } from '../../src/quota/account-lineage-readers.js';
import { fetchAntigravityQuota, readAntigravityQuotaAccountLineage } from '../../src/quota/fetchers/antigravity.js';
import { fetchClaudeQuota, readClaudeQuotaAccountLineage } from '../../src/quota/fetchers/claude.js';
import { fetchCodexQuota, readCodexQuotaAccountLineage } from '../../src/quota/fetchers/codex.js';
import { fetchCursorQuota, readCursorQuotaAccountLineage } from '../../src/quota/fetchers/cursor.js';
import type { QuotaFetch, QuotaFetchResponse, QuotaSpawn } from '../../src/quota/fetchers/deps.js';
import { saveQuotaCache } from '../../src/quota/persist.js';
import { clearQuotaCache, hydrateQuotaCacheFromDisk, quotaHydrationConfirmed, readQuotaCache } from '../../src/quota/refresh.js';
import type { ProviderQuota, QuotaProvider } from '../../src/quota/types.js';

const roots: string[] = [];
afterEach(() => {
    clearQuotaCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'quota-lineage-adapters-')); roots.push(root); return root; };
const writeJson = (file: string, value: unknown): void => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
/** Unsigned synthetic JWT; only the claims matter to the readers. */
const jwt = (claims: Record<string, unknown>): string =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'synthetic-signature'].join('.');
const forbiddenSpawn: QuotaSpawn = () => { throw new Error('no CLI may be spawned in this suite'); };
const jsonResponse = (body: unknown, status = 200): QuotaFetchResponse => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body),
});
const expectAccount = (lineage: QuotaAccountLineage): void => {
    expect(lineage.kind).toBe('account');
    // The digest carries no fixture id, email, issuer or token text.
    expect(JSON.stringify(lineage)).not.toMatch(/fixture|example|issuer|synthetic|user_|acct/);
};

const reading = (provider: QuotaProvider, lineage: QuotaAccountLineage): ProviderQuota => ({
    provider, status: 'ok', session: null,
    weekly: { usedPercent: 37, windowMinutes: 10080, resetsAt: 1_900_000_000_000 },
    updatedAt: 1_800_000_000_000, error: null,
    metadata: { source: 'fixture', accountLineage: lineage },
});

/** Write a confirmed reading, "restart", and hydrate through the DEFAULT readers. */
async function hydrateAfterRestart(provider: QuotaProvider, env: NodeJS.ProcessEnv, stored: QuotaAccountLineage): Promise<ProviderQuota | undefined> {
    clearQuotaCache();
    saveQuotaCache({ [provider]: reading(provider, stored) }, env);
    hydrateQuotaCacheFromDisk(env);
    await quotaHydrationConfirmed();
    return readQuotaCache()?.[provider] as ProviderQuota | undefined;
}

// ── claude-cli: ~/.claude.json oauthAccount ─────────────────────────────
describe('claude-cli lineage (oauthAccount.accountUuid + organizationUuid)', () => {
    const setup = () => {
        const root = tempRoot();
        const env = { ADHDEV_CONFIG_DIR: join(root, 'adhdev'), CLAUDE_CONFIG_DIR: join(root, 'claude') } as NodeJS.ProcessEnv;
        const write = (account: Record<string, unknown> | null, raw?: string) => writeJson(join(root, 'claude', '.claude.json'),
            raw ?? { theme: 'dark', ...(account ? { oauthAccount: account } : {}) });
        return { env, write };
    };
    const account = (uuid: string, extra: Record<string, unknown> = {}) => ({
        accountUuid: uuid, organizationUuid: 'org-fixture-1', emailAddress: 'synthetic-a@example.invalid', displayName: 'Fixture', ...extra,
    });

    it('is stable across profile refreshes and label changes; isolates another account or organization', () => {
        const { env, write } = setup();
        write(account('fixture-account-a'));
        const a = readClaudeQuotaAccountLineage({ env });
        expectAccount(a);
        write(account('fixture-account-a', { emailAddress: 'synthetic-renamed@example.invalid', profileFetchedAt: 2 }));
        expect(sameQuotaAccount(a, readClaudeQuotaAccountLineage({ env }))).toBe(true);
        write(account('fixture-account-b'));
        expect(sameQuotaAccount(a, readClaudeQuotaAccountLineage({ env }))).toBe(false);
        write(account('fixture-account-a', { organizationUuid: 'org-fixture-2' }));
        expect(sameQuotaAccount(a, readClaudeQuotaAccountLineage({ env }))).toBe(false);
    });
    it.each([
        ['no oauthAccount (API-key sign-in)', null, undefined],
        ['blank accountUuid', { accountUuid: ' ' }, undefined],
        ['malformed JSON', null, '{"oauthAccount":'],
        ['email only', { emailAddress: 'synthetic@example.invalid' }, undefined],
    ])('%s → unknown', (_label, value, raw) => {
        const { env, write } = setup();
        write(value as Record<string, unknown> | null, raw);
        expect(readClaudeQuotaAccountLineage({ env })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('a test runtime without a synthetic CLAUDE_CONFIG_DIR never reads the real home', () => {
        expect(readClaudeQuotaAccountLineage({ env: {} })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('keeps a setup failure account-scoped without claiming a measurement', async () => {
        const { env, write } = setup();
        write(account('fixture-account-a'));
        // No wrapper installed → setup-required failure, still account-scoped.
        const quota = await fetchClaudeQuota({ env, now: () => 1_800_000_000_000 });
        expect(quota.metadata?.failureKind).toBe('setup-required');
        expect(quota.session).toBeNull();
        expect(quota.weekly).toBeNull();
        expect(quota.metadata?.accountLineage).toEqual(readClaudeQuotaAccountLineage({ env }));
    });
    it('restart hydration keeps a matching reading and isolates a different account', async () => {
        const { env, write } = setup();
        write(account('fixture-account-a'));
        const a = readClaudeQuotaAccountLineage({ env });
        expect((await hydrateAfterRestart('claude-cli', env, a))?.weekly?.usedPercent).toBe(37);
        write(account('fixture-account-b'));
        const restored = await hydrateAfterRestart('claude-cli', env, a);
        expect(restored?.weekly).toBeNull();
        expect(restored?.metadata?.lineageUncertain).toBe(true);
    });
});

// ── codex-cli: $CODEX_HOME/auth.json id_token ───────────────────────────
describe('codex-cli lineage (id_token iss+sub + account_id)', () => {
    const ISS = 'https://auth.issuer.test';
    const setup = () => {
        const root = tempRoot();
        const env = { ADHDEV_CONFIG_DIR: join(root, 'adhdev'), CODEX_HOME: join(root, 'codex') } as NodeJS.ProcessEnv;
        const write = (value: unknown) => writeJson(join(root, 'codex', 'auth.json'), value);
        return { root, env, write };
    };
    const auth = (sub: string, rotation: string, accountId = 'acct-fixture-1', extra: Record<string, unknown> = {}) => ({
        auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: rotation,
        tokens: {
            id_token: jwt({ iss: ISS, sub, exp: 100, jti: `id-${rotation}`, email: 'synthetic@example.invalid' }),
            access_token: jwt({ iss: ISS, sub, jti: `access-${rotation}` }), refresh_token: `synthetic-refresh-${rotation}`, account_id: accountId,
        },
        ...extra,
    });

    it('same account across token rotation keeps lineage; another user or workspace isolates', () => {
        const { env, write } = setup();
        write(auth('fixture-user-a', 'r1'));
        const a = readCodexQuotaAccountLineage({ env });
        expectAccount(a);
        write(auth('fixture-user-a', 'r2'));
        expect(sameQuotaAccount(a, readCodexQuotaAccountLineage({ env }))).toBe(true);
        write(auth('fixture-user-b', 'r3'));
        expect(sameQuotaAccount(a, readCodexQuotaAccountLineage({ env }))).toBe(false);
        write(auth('fixture-user-a', 'r4', 'acct-fixture-2'));
        expect(sameQuotaAccount(a, readCodexQuotaAccountLineage({ env }))).toBe(false);
    });
    it.each([
        ['API-key mode', { auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-key', tokens: null }],
        ['opaque id_token', { auth_mode: 'chatgpt', tokens: { id_token: 'opaque', account_id: 'acct-fixture-1' } }],
        ['id_token without sub', { auth_mode: 'chatgpt', tokens: { id_token: jwt({ iss: ISS }), account_id: 'acct-fixture-1' } }],
        ['malformed JSON', '{"tokens":'],
    ])('%s → unknown', (_label, value) => {
        const { env, write } = setup();
        write(value);
        expect(readCodexQuotaAccountLineage({ env })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('missing auth.json (keyring store) → unknown; no synthetic CODEX_HOME in tests → unknown', () => {
        expect(readCodexQuotaAccountLineage({ env: setup().env })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
        expect(readCodexQuotaAccountLineage({ env: {} })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('fetch stamps the account on a rollout reading', async () => {
        const { root, env, write } = setup();
        write(auth('fixture-user-a', 'r1'));
        const dir = join(root, 'codex', 'sessions', '2026', '08', '20');
        writeJson(join(dir, 'rollout-2026-08-20T05-31-00-aaa.jsonl'), JSON.stringify({
            timestamp: '2026-08-20T05:31:25.185Z', type: 'event_msg',
            payload: { type: 'token_count', rate_limits: { primary: { used_percent: 2, window_minutes: 10080, resets_at: 1787796696 }, secondary: null } },
        }) + '\n');
        const quota = await fetchCodexQuota({ env, now: () => Date.parse('2026-08-20T06:00:00.000Z'), spawn: forbiddenSpawn });
        expect(quota.status).toBe('ok');
        expect(quota.metadata?.accountLineage).toEqual(readCodexQuotaAccountLineage({ env }));
    });
    it('restart hydration keeps a matching reading across rotation and isolates a different account', async () => {
        const { env, write } = setup();
        write(auth('fixture-user-a', 'r1'));
        const a = readCodexQuotaAccountLineage({ env });
        write(auth('fixture-user-a', 'r2'));
        expect((await hydrateAfterRestart('codex-cli', env, a))?.weekly?.usedPercent).toBe(37);
        write(auth('fixture-user-b', 'r3'));
        expect((await hydrateAfterRestart('codex-cli', env, a))?.weekly).toBeNull();
    });
});

// ── cursor-cli: ~/.cursor/cli-config.json authInfo.authId ───────────────
describe('cursor-cli lineage (authInfo.authId, cross-checked with the token subject)', () => {
    const ISS = 'https://authentication.issuer.test';
    const AUTH_A = 'fixture-connection|user_fixture_a';
    const AUTH_B = 'fixture-connection|user_fixture_b';
    const setup = () => {
        const root = tempRoot();
        const env = {
            ADHDEV_CONFIG_DIR: join(root, 'adhdev'), HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'),
            ADHDEV_CURSOR_PLATFORM: 'linux', CURSOR_CLI_VERSION: '2026.08.11-e8db854',
        } as NodeJS.ProcessEnv;
        const config = (authId: string | null, raw?: string) => writeJson(join(root, 'home', '.cursor', 'cli-config.json'),
            raw ?? { version: 1, authInfo: authId === null ? undefined : { email: 'synthetic@example.invalid', displayName: 'Fixture', userId: 7, authId } });
        const token = (sub: string, rotation: string) => writeJson(join(root, 'xdg', 'cursor', 'auth.json'),
            { accessToken: jwt({ iss: ISS, sub, jti: rotation }), refreshToken: `synthetic-refresh-${rotation}` });
        return { env, config, token };
    };
    const usage = { billing_cycle_start: '1785542400000', billing_cycle_end: '1788220800000', plan_usage: { total_spend: 1200, limit: 2000 },
        spend_limit_usage: { individual_used: 1, individual_limit: 5000, limit_type: 'individual' }, enabled: true };

    it('same account across token rotation keeps lineage; another account isolates', () => {
        const { env, config, token } = setup();
        config(AUTH_A); token(AUTH_A, 'r1');
        const a = readCursorQuotaAccountLineage({ env });
        expectAccount(a);
        token(AUTH_A, 'r2');
        expect(sameQuotaAccount(a, readCursorQuotaAccountLineage({ env }))).toBe(true);
        config(AUTH_B); token(AUTH_B, 'r3');
        expect(sameQuotaAccount(a, readCursorQuotaAccountLineage({ env }))).toBe(false);
    });
    it.each([
        ['no authInfo', (s: ReturnType<typeof setup>) => s.config(null)],
        ['malformed cli-config', (s: ReturnType<typeof setup>) => s.config(null, '{"authInfo":')],
        ['token subject disagrees with the recorded account', (s: ReturnType<typeof setup>) => { s.config(AUTH_A); s.token(AUTH_B, 'r1'); }],
    ])('%s → unknown', (_label, arrange) => {
        const s = setup();
        arrange(s);
        expect(readCursorQuotaAccountLineage({ env: s.env })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('no synthetic HOME in a test runtime → unknown', () => {
        expect(readCursorQuotaAccountLineage({ env: {} })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('fetch stamps the account; a sign-in switch during the request isolates the reading', async () => {
        const { env, config, token } = setup();
        config(AUTH_A); token(AUTH_A, 'r1');
        const ok = await fetchCursorQuota({ env, now: () => 1_786_000_000_000, fetch: async () => jsonResponse(usage) });
        expect(ok.status).toBe('ok');
        expect(ok.metadata?.accountLineage).toEqual(readCursorQuotaAccountLineage({ env }));
        const switching: QuotaFetch = async () => { config(AUTH_B); token(AUTH_B, 'r2'); return jsonResponse(usage); };
        const switched = await fetchCursorQuota({ env, now: () => 1_786_000_000_000, fetch: switching });
        expect(switched.monthly ?? null).toBeNull();
        expect(switched.metadata?.lineageUncertain).toBe(true);
    });
    it('an exchanged API-key token must prove the recorded account', async () => {
        const { env, config } = setup();
        config(AUTH_A);
        const exchange = (sub: string): QuotaFetch => async (url) => url.endsWith('/auth/exchange_user_api_key')
            ? jsonResponse({ accessToken: sub ? jwt({ iss: ISS, sub }) : 'opaque-exchanged' }) : jsonResponse(usage);
        const apiEnv = { ...env, CURSOR_API_KEY: 'synthetic-api-key' };
        const proven = await fetchCursorQuota({ env: apiEnv, now: () => 1_786_000_000_000, fetch: exchange(AUTH_A) });
        expect(proven.metadata?.accountLineage?.kind).toBe('account');
        for (const sub of [AUTH_B, '']) {
            const other = await fetchCursorQuota({ env: apiEnv, now: () => 1_786_000_000_000, fetch: exchange(sub) });
            expect(other.status).toBe('ok'); // unknown, not an account switch
            expect(other.metadata?.accountLineage).toBeUndefined();
        }
    });
    it('restart hydration keeps a matching reading across rotation and isolates a different account', async () => {
        const { env, config, token } = setup();
        config(AUTH_A); token(AUTH_A, 'r1');
        const a = readCursorQuotaAccountLineage({ env });
        token(AUTH_A, 'r2');
        expect((await hydrateAfterRestart('cursor-cli', env, a))?.weekly?.usedPercent).toBe(37);
        config(AUTH_B); token(AUTH_B, 'r3');
        expect((await hydrateAfterRestart('cursor-cli', env, a))?.weekly).toBeNull();
    });
});

// ── antigravity-cli: stored Google id_token ─────────────────────────────
describe('antigravity-cli lineage (stored id_token iss+sub)', () => {
    const ISS = 'https://accounts.issuer.test';
    const setup = () => {
        const root = tempRoot();
        const env = { ADHDEV_CONFIG_DIR: join(root, 'adhdev'), HOME: join(root, 'home'), ADHDEV_ANTIGRAVITY_PLATFORM: 'linux' } as NodeJS.ProcessEnv;
        const write = (value: unknown) => writeJson(join(root, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), value);
        return { env, write };
    };
    const blob = (sub: string | null, rotation: string) => ({
        token: { access_token: `synthetic-access-${rotation}`, token_type: 'Bearer', refresh_token: `synthetic-refresh-${rotation}`, expiry: '2099-01-01T00:00:00Z' },
        auth_method: 'consumer',
        ...(sub === null ? {} : { id_token: jwt({ iss: ISS, sub, jti: rotation, email: 'synthetic@example.invalid' }) }),
    });

    it('same account across token rotation keeps lineage; another account isolates', async () => {
        const { env, write } = setup();
        write(blob('fixture-google-a', 'r1'));
        const a = await readAntigravityQuotaAccountLineage({ env });
        expectAccount(a);
        write(blob('fixture-google-a', 'r2'));
        expect(sameQuotaAccount(a, await readAntigravityQuotaAccountLineage({ env }))).toBe(true);
        write(blob('fixture-google-b', 'r3'));
        expect(sameQuotaAccount(a, await readAntigravityQuotaAccountLineage({ env }))).toBe(false);
    });
    it.each([
        ['no id_token', blob(null, 'r1')],
        ['opaque id_token', { ...blob(null, 'r1'), id_token: 'opaque' }],
        ['malformed blob', '{"token":'],
    ])('%s → unknown', async (_label, value) => {
        const { env, write } = setup();
        write(value);
        expect(await readAntigravityQuotaAccountLineage({ env })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('no injected store in a test runtime → unknown (never the real keychain)', async () => {
        expect(await readAntigravityQuotaAccountLineage({ env: { ADHDEV_ANTIGRAVITY_PLATFORM: 'darwin' } })).toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
    it('fetch stamps the account across rotation and isolates a switch during the request', async () => {
        const { env, write } = setup();
        write(blob('fixture-google-a', 'r1'));
        const rotating: QuotaFetch = async () => { write(blob('fixture-google-a', 'r2')); return jsonResponse({}, 503); };
        const same = await fetchAntigravityQuota({ env, now: () => 1_800_000_000_000, fetch: rotating, spawn: forbiddenSpawn });
        expect(same.metadata?.accountLineage).toEqual(await readAntigravityQuotaAccountLineage({ env }));
        expect(same.metadata?.lineageUncertain).toBeUndefined();
        const switching: QuotaFetch = async () => { write(blob('fixture-google-b', 'r3')); return jsonResponse({}, 503); };
        const switched = await fetchAntigravityQuota({ env, now: () => 1_800_000_000_000, fetch: switching, spawn: forbiddenSpawn });
        expect(switched.metadata?.lineageUncertain).toBe(true);
    });
    it('restart hydration confirms a matching reading asynchronously and isolates a different account', async () => {
        const { env, write } = setup();
        write(blob('fixture-google-a', 'r1'));
        const a = await readAntigravityQuotaAccountLineage({ env });
        write(blob('fixture-google-a', 'r2'));
        clearQuotaCache();
        saveQuotaCache({ 'antigravity-cli': reading('antigravity-cli', a) }, env);
        hydrateQuotaCacheFromDisk(env);
        // Until the credential store answers, only diagnostic state shows.
        expect(readQuotaCache()?.['antigravity-cli'].weekly).toBeNull();
        await quotaHydrationConfirmed();
        expect(readQuotaCache()?.['antigravity-cli'].weekly?.usedPercent).toBe(37);
        write(blob('fixture-google-b', 'r3'));
        expect((await hydrateAfterRestart('antigravity-cli', env, a))?.weekly).toBeNull();
    });
    it('a live measurement landing before the store answers is never overwritten by the confirmation', async () => {
        const { env, write } = setup();
        write(blob('fixture-google-a', 'r1'));
        const a = await readAntigravityQuotaAccountLineage({ env });
        clearQuotaCache();
        saveQuotaCache({ 'antigravity-cli': reading('antigravity-cli', a) }, env);
        let release!: (lineage: QuotaAccountLineage) => void;
        hydrateQuotaCacheFromDisk(env, undefined, () => new Promise((resolve) => { release = resolve; }));
        clearQuotaCache();
        release(a);
        await quotaHydrationConfirmed();
        expect(readQuotaCache()).toBeUndefined();
    });
});

describe('shared settlement and dispatch', () => {
    it('settleAccountQuota: same account stamps, both unknown stays unstamped, any disagreement isolates', () => {
        const root = tempRoot();
        const env = { CLAUDE_CONFIG_DIR: root } as NodeJS.ProcessEnv;
        writeJson(join(root, '.claude.json'), { oauthAccount: { accountUuid: 'fixture-a' } });
        const a = readClaudeQuotaAccountLineage({ env });
        writeJson(join(root, '.claude.json'), { oauthAccount: { accountUuid: 'fixture-b' } });
        const b = readClaudeQuotaAccountLineage({ env });
        const q = reading('claude-cli', UNKNOWN_ACCOUNT_LINEAGE);
        delete q.metadata!.accountLineage;
        expect(settleAccountQuota(q, a, a).metadata?.accountLineage).toEqual(a);
        expect(settleAccountQuota(q, UNKNOWN_ACCOUNT_LINEAGE, UNKNOWN_ACCOUNT_LINEAGE)).toBe(q);
        for (const [before, after] of [[a, b], [a, UNKNOWN_ACCOUNT_LINEAGE], [UNKNOWN_ACCOUNT_LINEAGE, a]] as const) {
            const settled = settleAccountQuota(q, before, after);
            expect(settled.weekly).toBeNull();
            expect(settled.metadata?.lineageUncertain).toBe(true);
        }
    });
    it('opencode has no owning account, so its readings are keyed to the local usage store', () => {
        // Policy (rc.19): usage-only readings from opencode's own store carry over a restart
        // for the same store instead of staying UNKNOWN (see opencode-quota-lineage.test.ts).
        expect(readCurrentQuotaAccountLineage('opencode', { HOME: '/home/u' })).not.toEqual(UNKNOWN_ACCOUNT_LINEAGE);
    });
});
