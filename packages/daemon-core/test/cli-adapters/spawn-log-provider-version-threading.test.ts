import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createCliAdapter } from '../../src/providers/spec/route.js';
import { LOG } from '../../src/logging/logger.js';
import type { CliProviderModule } from '../../src/cli-adapters/provider-cli-shared.js';
import type { PtyRuntimeTransport, PtySpawnOptions, PtyTransportFactory } from '../../src/cli-adapters/pty-transport.js';

/**
 * ★SPAWN-LOG-VERSION — end-to-end over the REAL wiring:
 * createCliAdapter → SpecCliAdapter → FsmDriver → resolveCliSpawnPlanFromParts.
 *
 * The unit test in spawn-argv-logging.test.ts proves the leaf function renders
 * a version it is handed. That is not what broke. What broke is the THREADING:
 * `CliSpecV4` (specs/4.0.json) carries no version field, and FsmDriver had no
 * other source, so `buildAdapterOpts()` passed nothing and every spec-path
 * spawn logged `Spawning (spec vunknown)` — even though route.ts was holding
 * the resolved manifest the whole time.
 *
 * Since the legacy ProviderCliAdapter engine was deleted (48e5ed1a) the spec
 * path is the ONLY path, so this affected every CLI on every launch. It cost
 * real time on 2026-09-17, when the question "which cursor-cli bundle is this
 * daemon actually running?" could not be answered from the log — the daemon
 * was serving 1.0.5 while every artifact on disk said 1.0.6.
 *
 * Asserting through the real chain is the point: a test that calls the leaf
 * function directly passes just as happily with the threading severed.
 */

const tmpDirs: string[] = [];
afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { infoSpy = vi.spyOn(LOG, 'info').mockImplementation(() => undefined as any); });
afterEach(() => { infoSpy.mockRestore(); });

function spawnLine(): string {
    const lines = infoSpy.mock.calls
        .filter((c) => String(c[1] ?? '').includes('Spawning'))
        .map((c) => String(c[1]));
    if (lines.length !== 1) throw new Error(`expected exactly one spawn line, got ${lines.length}`);
    return lines[0];
}

function writeSpec(id: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spawn-version-${id}-`));
    tmpDirs.push(dir);
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
        $schema: 'adhdev:cli/spec@4',
        id,
        name: id,
        binary: '/bin/true',
        spawn_args: [],
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
    }));
    return specPath;
}

class RecordingTransportFactory implements PtyTransportFactory {
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        return {
            pid: 1,
            ready: Promise.resolve(),
            write: () => {},
            resize: () => {},
            kill: () => {},
            onData: () => {},
            onExit: () => {},
        };
    }
}

async function spawnThroughRealWiring(type: string, providerVersion?: string): Promise<void> {
    const adapter = createCliAdapter(
        {
            type,
            name: type,
            category: 'cli',
            spawn: { command: '/bin/true', args: [] },
            ...(providerVersion ? { providerVersion } : {}),
            _resolvedSpecPath: writeSpec(type),
        } as unknown as CliProviderModule,
        os.tmpdir(),
        [],
        {},
        new RecordingTransportFactory(),
    );
    await adapter.spawn();
    await adapter.stop?.();
}

describe('★spawn log carries the manifest version through the real spec-path wiring', () => {
    it('★logs the manifest version, not vunknown (the whole-fleet regression)', async () => {
        await spawnThroughRealWiring('cursor-cli', '1.0.6');

        const line = spawnLine();
        expect(line).toContain('spec v1.0.6');
        // The defect's signature. Before the fix this is what every CLI logged.
        expect(line).not.toContain('vunknown');
    });

    it('★distinguishes two bundles of the same provider — the question that was unanswerable', async () => {
        // 1.0.5 vs 1.0.6 of cursor-cli differ in whether they declare
        // delegatedWorkerIsolation at all, which decides whether a delegated
        // worker gets --approve-mcps. The log has to tell them apart.
        await spawnThroughRealWiring('cursor-cli', '1.0.5');
        expect(spawnLine()).toContain('spec v1.0.5');
    });

    it('falls back to vunknown when the manifest genuinely carries no version', async () => {
        // Out-of-tree providers may omit it; honest reporting is still correct
        // there. The regression was production falling into this branch always.
        await spawnThroughRealWiring('kimi');
        expect(spawnLine()).toContain('spec vunknown');
    });
});
