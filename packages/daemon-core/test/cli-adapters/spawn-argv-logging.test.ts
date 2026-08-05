import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveCliSpawnPlanFromParts } from '../../src/cli-adapters/provider-cli-runtime.js';
import { LOG } from '../../src/logging/logger.js';

// SPAWN ARGV LOGGING — diagnosing a bad resume argv requires seeing the argv.
//
// The kimi resume defect ("Session <uuid> not found") cost two diagnostic
// round-trips because the daemon logged only the working directory at spawn.
// The first fix logged argv inside ProviderCliAdapter, which covered kimi and
// SILENTLY MISSED codex: the spec/FSM path spawns through FsmDriver, which
// never touches that adapter method. Both paths funnel through
// resolveCliSpawnPlanFromParts, so the log belongs here — one chokepoint,
// no third bypass.
//
// The manifest version matters as much as the argv: a daemon resolves
// providers from the content-addressed channel store and that pin only
// advances on check_provider_updates, so the repo checkout can show a fix the
// running daemon does not have. Version in the line is what distinguishes
// "our expansion is wrong" from "this machine is pinned to an old spec".

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => { infoSpy = vi.spyOn(LOG, 'info').mockImplementation(() => undefined as any); });
afterEach(() => { infoSpy.mockRestore(); });

function spawnLines(): string[] {
    return infoSpy.mock.calls
        .filter((c) => String(c[1] ?? '').includes('Spawning'))
        .map((c) => String(c[1]));
}

describe('spawn argv logging', () => {
    it('logs the full argv, not just the working directory', () => {
        resolveCliSpawnPlanFromParts({
            command: 'kimi',
            baseArgs: [],
            workingDir: '/tmp/ws',
            extraArgs: ['-S', 'session_3ea375d1-9a4c-4b55-bfee-96a253a422ec'],
            diagnosticCliType: 'kimi',
            diagnosticProviderVersion: '1.0.3',
        });

        const lines = spawnLines();
        expect(lines).toHaveLength(1);
        // The resume argv is the whole point — a line without it cannot
        // distinguish a wrong-shaped session id from any other launch failure.
        expect(lines[0]).toContain('-S session_3ea375d1-9a4c-4b55-bfee-96a253a422ec');
        expect(lines[0]).toContain('[kimi]');
        expect(lines[0]).toContain('spec v1.0.3');
    });

    it('logs on the spec/FSM path too, which the adapter-local log missed', () => {
        // FsmDriver passes spec identity but has no manifest version to give
        // (CliSpecV4 is the FSM runtime spec, not the provider manifest).
        resolveCliSpawnPlanFromParts({
            command: 'codex',
            baseArgs: [],
            workingDir: '/tmp/ws',
            extraArgs: ['resume', '019fb1b3-a66a-7b33-bbc3-a5f9e8b1a65c'],
            diagnosticCliType: 'codex-cli',
        });

        const lines = spawnLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('resume 019fb1b3-a66a-7b33-bbc3-a5f9e8b1a65c');
        expect(lines[0]).toContain('[codex-cli]');
        // Honest about what it does not know, rather than implying a version.
        expect(lines[0]).toContain('spec vunknown');
    });

    it('never logs prompt or transcript text (content boundary)', () => {
        // Args are provider flags and ids. If a caller ever routes user text
        // through extraArgs this stays content-free only by that contract, so
        // the assertion documents it: what we log is exactly the argv we spawn.
        const plan = resolveCliSpawnPlanFromParts({
            command: 'kimi',
            baseArgs: ['--flag'],
            workingDir: '/tmp/ws',
            extraArgs: ['-S', 'session_abc'],
            diagnosticCliType: 'kimi',
        });
        expect(spawnLines()[0]).toContain(plan.allArgs.join(' '));
    });
});
