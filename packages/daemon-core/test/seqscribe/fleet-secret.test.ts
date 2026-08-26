import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    shutdownDaemonComponents,
    tryOpenDaemonSeqscribeNode,
} from '../../src/boot/daemon-lifecycle.js';
import { ADHDEV_AUTHORITY_ID, resolveFleetSecret } from '../../src/seqscribe/authority.js';
import {
    FLEET_SECRET_FILE,
    loadStoredFleetSecret,
    storeFleetSecret,
} from '../../src/seqscribe/fleet-secret.js';
import { openSeqscribeNode, type SeqscribeNodeHandle } from '../../src/seqscribe/node.js';
import {
    assistantJournalPolicy,
    configSettingsPolicy,
    fleetStatusPolicy,
    meshEventsPolicy,
    sessionTranscriptPolicy,
    ASSISTANT_JOURNAL_TOPIC,
    CONFIG_SETTINGS_TOPIC,
    meshEventsTopic,
} from '../../src/seqscribe/topics.js';

/**
 * Fleet-secret storage and resolution (Phase 1).
 *
 * The properties pinned here are the ones a later refactor is most likely to
 * break silently:
 *
 *  1. PRIORITY — the env var WINS over the stored secret (standalone/test
 *     determinism); the stored secret wins over nothing-at-all. Reversing this
 *     makes a dogfood env override silently ineffective.
 *  2. FILE HYGIENE — the store is mode 0600, outside config.json (D7), and a
 *     corrupt file degrades to provisional mode instead of throwing at boot.
 *  3. PROVISIONAL DEGRADATION — without any secret the node runs
 *     metadata-topics-only: the content topics all name `finalityAuthority`,
 *     and the library refuses to define them without verifyFinality.
 *
 * Isolation: every test passes an explicit env whose ADHDEV_CONFIG_DIR is a
 * per-test tmp dir (or an env that never reaches the config dir at all), so
 * the real ~/.adhdev is never touched.
 */

const tmpDirs: string[] = [];
const handles: SeqscribeNodeHandle[] = [];

function tmpDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `adhdev-sqsec-${name}-`));
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

describe('resolveFleetSecret priority', () => {
    it('env var wins over the stored secret', () => {
        expect(resolveFleetSecret({ ADHDEV_SEQSCRIBE_FLEET_SECRET: 'env-secret' }, 'stored-secret'))
            .toBe('env-secret');
    });

    it('falls back to the stored secret when the env var is unset', () => {
        expect(resolveFleetSecret({}, 'stored-secret')).toBe('stored-secret');
    });

    it('returns null when neither source has a secret', () => {
        expect(resolveFleetSecret({}, null)).toBeNull();
        expect(resolveFleetSecret({})).toBeNull();
    });

    it('ignores a whitespace-only env var and falls through to the store', () => {
        expect(resolveFleetSecret({ ADHDEV_SEQSCRIBE_FLEET_SECRET: '   ' }, 'stored-secret'))
            .toBe('stored-secret');
        expect(resolveFleetSecret({ ADHDEV_SEQSCRIBE_FLEET_SECRET: '  ' })).toBeNull();
    });
});

describe('fleet secret store', () => {
    it('returns null when no file exists', () => {
        expect(loadStoredFleetSecret(envFor(tmpDir('missing')))).toBeNull();
    });

    it('writes {secret, version} JSON at mode 0600 and round-trips it', () => {
        const env = envFor(tmpDir('store'));
        storeFleetSecret('fleet-secret-value', 3, env);

        const path = join(env.ADHDEV_CONFIG_DIR!, FLEET_SECRET_FILE);
        expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
            secret: 'fleet-secret-value',
            version: 3,
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(loadStoredFleetSecret(env)).toEqual({ secret: 'fleet-secret-value', version: 3 });
    });

    it('treats corrupt JSON as absent instead of throwing', () => {
        const env = envFor(tmpDir('corrupt'));
        writeFileSync(join(env.ADHDEV_CONFIG_DIR!, FLEET_SECRET_FILE), 'this is not json{');
        expect(loadStoredFleetSecret(env)).toBeNull();
    });

    it('treats a wrong-shaped file as absent instead of throwing', () => {
        const env = envFor(tmpDir('shape'));
        writeFileSync(
            join(env.ADHDEV_CONFIG_DIR!, FLEET_SECRET_FILE),
            JSON.stringify({ secret: 42, version: 'one' }),
        );
        expect(loadStoredFleetSecret(env)).toBeNull();
    });

    it('rejects invalid input rather than persisting it', () => {
        const env = envFor(tmpDir('invalid'));
        expect(() => storeFleetSecret('', 1, env)).toThrow();
        expect(() => storeFleetSecret('ok', 0, env)).toThrow();
        expect(() => storeFleetSecret('ok', 1.5, env)).toThrow();
        expect(loadStoredFleetSecret(env)).toBeNull();
    });
});

describe('topic policies and finalityAuthority', () => {
    it('stamps the fleet authority on every content policy', () => {
        for (const policy of [assistantJournalPolicy(), sessionTranscriptPolicy(), configSettingsPolicy()]) {
            expect(policy.finalityAuthority).toBe(ADHDEV_AUTHORITY_ID);
            expect(policy.access).toBe('content');
        }
        expect(ADHDEV_AUTHORITY_ID).toBe('adhdev-coordinator');
    });

    it('leaves metadata policies without an authority (Phase 6 cloud promotion)', () => {
        expect(meshEventsPolicy().finalityAuthority).toBeUndefined();
        expect(fleetStatusPolicy().finalityAuthority).toBeUndefined();
    });
});

describe('openSeqscribeNode provisional degradation', () => {
    it('defines metadata topics only when no secret exists anywhere', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('provisional'), 'seq.db'),
            env: {},
            storedFleetSecret: null,
            meshIds: ['mesh_abc'],
        });
        handles.push(handle);

        const topics = handle.topics.map((d) => d.topic);
        expect(topics).not.toContain(ASSISTANT_JOURNAL_TOPIC);
        expect(topics).not.toContain(CONFIG_SETTINGS_TOPIC);
        expect(topics).toContain(meshEventsTopic('mesh_abc'));
        expect(handle.authorityEnabled).toBe(false);
    });

    it('defines every topic when the env var carries the secret', () => {
        const handle = openSeqscribeNode({
            dbPath: join(tmpDir('authorized'), 'seq.db'),
            env: { ADHDEV_SEQSCRIBE_FLEET_SECRET: 'fleet-secret' },
            storedFleetSecret: null,
            meshIds: ['mesh_abc'],
        });
        handles.push(handle);

        const topics = handle.topics.map((d) => d.topic);
        expect(topics).toEqual(
            expect.arrayContaining([
                ASSISTANT_JOURNAL_TOPIC,
                CONFIG_SETTINGS_TOPIC,
                meshEventsTopic('mesh_abc'),
            ]),
        );
        expect(handle.authorityEnabled).toBe(true);
    });

    it('defines every topic from the stored secret alone (auth_ok path)', () => {
        const dir = tmpDir('stored');
        storeFleetSecret('stored-fleet-secret', 1, envFor(dir));
        const handle = openSeqscribeNode({
            dbPath: join(dir, 'seq.db'),
            env: envFor(dir),
            // storedFleetSecret deliberately undefined: the node must read the
            // auth_ok-persisted store itself.
        });
        handles.push(handle);

        const topics = handle.topics.map((d) => d.topic);
        expect(topics).toContain(ASSISTANT_JOURNAL_TOPIC);
        expect(handle.authorityEnabled).toBe(true);
    });
});

describe('daemon lifecycle seqscribe boot', () => {
    it('creates seqscribe.db, issues a writerId, and enables authority from the stored secret', () => {
        const dir = tmpDir('daemon-boot');
        const env = envFor(dir);
        const dbPath = join(dir, 'seqscribe.db');
        storeFleetSecret('auth-ok-delivered-secret', 4, env);

        const handle = tryOpenDaemonSeqscribeNode({
            daemonId: 'daemon_machine-1',
            env,
            dbPath,
        });
        expect(handle).toBeDefined();
        handles.push(handle!);

        expect(existsSync(dbPath)).toBe(true);
        expect(handle!.writerId).toMatch(/^adhdev-[0-9a-f]{16}$/);
        expect(handle!.daemonId).toBe('daemon_machine-1');
        expect(handle!.authorityEnabled).toBe(true);
        expect(handle!.topics.map((definition) => definition.topic)).toContain(ASSISTANT_JOURNAL_TOPIC);
    });

    it('returns no handle instead of throwing when the node cannot open', () => {
        const dir = tmpDir('daemon-boot-fail-soft');
        expect(tryOpenDaemonSeqscribeNode({ env: envFor(dir), dbPath: dir })).toBeUndefined();
    });

    it('closes the node during shared daemon shutdown', async () => {
        let seqscribeClosed = false;
        await shutdownDaemonComponents({
            poller: { stop() {} },
            cdpInitializer: { stop() {} },
            agentStreamManager: { async dispose() {} },
            cliManager: { detachAll() {} },
            instanceManager: {
                removeByCategory() {},
                disposeAll() {},
            },
            cdpManagers: new Map(),
            seqscribeNode: {
                async close() { seqscribeClosed = true; },
            },
        } as any);

        expect(seqscribeClosed).toBe(true);
    });
});
