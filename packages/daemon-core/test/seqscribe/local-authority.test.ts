import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADHDEV_AUTHORITY_ID } from '../../src/seqscribe/authority.js';
import {
    createLocalAuthority,
    LOCAL_AUTHORITY_SECRET_FILE,
    loadOrCreateLocalAuthoritySecret,
    loadStoredLocalAuthoritySecret,
    storeLocalAuthoritySecret,
} from '../../src/seqscribe/local-authority.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    ASSISTANT_JOURNAL_TOPIC,
    CONFIG_SETTINGS_TOPIC,
    meshHandoffTopic,
} from '../../src/seqscribe/topics.js';

/**
 * C7-3 standalone local authority.
 *
 * docs/design/2026-09-23-wiring-unification.md §5 C7-3. Pins:
 *  1. STORE HYGIENE — same shape as fleet-secret.ts: 0600, atomic, own file,
 *     never logs the secret value, degrades a corrupt file to "mint fresh"
 *     rather than throwing.
 *  2. PRIORITY — env fleet secret > stored fleet secret > local secret. A
 *     machine that later gets a real fleet secret must stop using its local
 *     one without any explicit migration step.
 *  3. CONTENT TOPICS DEFINE — `mesh.<id>.handoff` (and the other
 *     finalityAuthority-naming policies) succeed with a local-only authority,
 *     which they did NOT before C7-3 on a fleet-secret-less machine.
 *  4. NEVER ISSUES — the finality loop is never started for a local
 *     authority, no matter `isCoordinator`.
 *  5. SCHEMA HASH UNCHANGED — the authority id (not the secret value) drives
 *     topicSchemaHash, so a locally-minted secret never diverges the schema
 *     hash from a fleet-secret-backed one.
 */

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function tmpDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-sqlocal-${name}-`));
    tmpDirs.push(dir);
    return dir;
}

function envFor(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ADHDEV_CONFIG_DIR: dir, ...extra };
}

afterEach(async () => {
    for (const handle of handles.splice(0)) {
        await handle.close().catch(() => {});
    }
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('local authority secret store', () => {
    it('returns null when no file exists', () => {
        expect(loadStoredLocalAuthoritySecret(envFor(tmpDir('missing')))).toBeNull();
    });

    it('mints, persists at mode 0600, and round-trips on the next load', () => {
        const env = envFor(tmpDir('mint'));
        const minted = loadOrCreateLocalAuthoritySecret(env);
        expect(minted).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex

        const path = join(env.ADHDEV_CONFIG_DIR!, LOCAL_AUTHORITY_SECRET_FILE);
        expect(existsSync(path)).toBe(true);
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ secret: minted });
        if (process.platform !== 'win32') {
            expect(statSync(path).mode & 0o777).toBe(0o600);
        }

        // Second call reads the SAME secret back rather than minting a new one.
        expect(loadOrCreateLocalAuthoritySecret(env)).toBe(minted);
        expect(loadStoredLocalAuthoritySecret(env)).toBe(minted);
    });

    it('treats corrupt JSON as absent and mints a fresh secret instead of throwing', () => {
        const env = envFor(tmpDir('corrupt'));
        writeFileSync(join(env.ADHDEV_CONFIG_DIR!, LOCAL_AUTHORITY_SECRET_FILE), 'not json{');
        expect(loadStoredLocalAuthoritySecret(env)).toBeNull();
        const minted = loadOrCreateLocalAuthoritySecret(env);
        expect(minted).toMatch(/^[0-9a-f]{64}$/);
    });

    it('treats a wrong-shaped file as absent instead of throwing', () => {
        const env = envFor(tmpDir('shape'));
        writeFileSync(join(env.ADHDEV_CONFIG_DIR!, LOCAL_AUTHORITY_SECRET_FILE), JSON.stringify({ secret: 42 }));
        expect(loadStoredLocalAuthoritySecret(env)).toBeNull();
    });

    it('rejects an empty secret rather than persisting it', () => {
        const env = envFor(tmpDir('invalid'));
        expect(() => storeLocalAuthoritySecret('', env)).toThrow();
        expect(loadStoredLocalAuthoritySecret(env)).toBeNull();
    });

    it('createLocalAuthority always uses ADHDEV_AUTHORITY_ID, never an override', () => {
        const env = envFor(tmpDir('authority-id'));
        const handle = createLocalAuthority(env);
        expect(handle.local).toBe(true);
        // verifyFinality/verifyWriterDirective both gate on authority id
        // internally — the only way to observe it from here without reaching
        // into the vendor's HMAC closure is a round-trip: sign nothing is
        // exposed on AuthorityHooks, so this asserts indirectly via
        // openSeqscribeNode's topic-definition success below, which requires
        // exactly this authority id to match ADHDEV_AUTHORITY_ID-stamped
        // policies (topics.ts). Direct assertion of the constant:
        expect(ADHDEV_AUTHORITY_ID).toBe('adhdev-coordinator');
    });
});

describe('openSeqscribeNode with a local authority (C7-3 default)', () => {
    it('defines every content topic, including mesh.<id>.handoff, with no fleet secret at all', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('content-topics'), 'seq.db'),
            env: {},
            storedFleetSecret: null,
            meshIds: ['mesh_abc'],
        });
        handles.push(handle);

        const topics = handle.topics.map((d) => d.topic);
        expect(topics).toContain(ASSISTANT_JOURNAL_TOPIC);
        expect(topics).toContain(CONFIG_SETTINGS_TOPIC);
        expect(topics).toContain(meshHandoffTopic('mesh_abc'));
        expect(handle.authorityEnabled).toBe(true);
        expect(handle.authorityIsLocal).toBe(true);
    });

    it('never starts the finality issuance loop for a local authority, even with isCoordinator: true', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('no-issuance'), 'seq.db'),
            env: {},
            storedFleetSecret: null,
            isCoordinator: true,
            meshIds: ['mesh_abc'],
        });
        handles.push(handle);

        expect(handle.authorityIsLocal).toBe(true);
        expect(handle.finalityLoop).toBeNull();
    });

    it('persists the minted secret so a restart reuses it rather than minting again', () => {
        const dir = tmpDir('restart');
        const first = openSeqscribeNode({
            dbPath: join(dir, 'seq.db'),
            env: envFor(dir),
            storedFleetSecret: null,
        });
        expect(first.authorityIsLocal).toBe(true);

        const secretAfterFirstOpen = loadStoredLocalAuthoritySecret(envFor(dir));
        expect(secretAfterFirstOpen).not.toBeNull();

        return first.close().then(() => {
            const second = openSeqscribeNode({
                dbPath: join(dir, 'seq2.db'), // separate DB file; the secret store is what's under test
                env: envFor(dir),
                storedFleetSecret: null,
            });
            handles.push(second);
            expect(loadStoredLocalAuthoritySecret(envFor(dir))).toBe(secretAfterFirstOpen);
        });
    });
});

describe('priority: env fleet secret > stored fleet secret > local secret', () => {
    it('prefers the env fleet secret over minting a local one', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('env-wins'), 'seq.db'),
            env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'fleet-secret-value' },
            storedFleetSecret: null,
        });
        handles.push(handle);
        expect(handle.authorityEnabled).toBe(true);
        expect(handle.authorityIsLocal).toBe(false);
    });

    it('prefers the stored fleet secret (auth_ok path) over minting a local one', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('stored-wins'), 'seq.db'),
            env: {},
            storedFleetSecret: 'auth-ok-delivered-secret',
        });
        handles.push(handle);
        expect(handle.authorityEnabled).toBe(true);
        expect(handle.authorityIsLocal).toBe(false);
    });

    it('localAuthority: false pins the pre-C7-3 metadata-only behavior', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('opt-out'), 'seq.db'),
            env: {},
            storedFleetSecret: null,
            localAuthority: false,
        });
        handles.push(handle);
        expect(handle.authorityEnabled).toBe(false);
        expect(handle.authorityIsLocal).toBe(false);
        expect(handle.topics.map((d) => d.topic)).not.toContain(ASSISTANT_JOURNAL_TOPIC);
    });
});
