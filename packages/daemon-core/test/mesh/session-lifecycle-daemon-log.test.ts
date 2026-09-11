import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// SESSION-LIFECYCLE-LOG (defect 1) — session start/end must reach the DAEMON LOG, not
// only the per-mesh ledger.
//
// The gap, measured 2026-09-11: a coordinator session was killed by SIGTERM at
// 11:45:17 and session-host wrote a tombstone, but grepping the whole day's daemon log
// (daemon-19223-2026-09-11.log, 14,715 lines) for `SIGTERM|terminat|kill|tombstone|
// coordinator` returned ZERO hits. The log's subsystems were Seqscribe / EventLoop /
// Mesh / ServerConn / P2P / MeshCommand / Quota / Provider — none of which says a
// session began or ended. The evidence existed on disk; nothing surfaced it where an
// operator would look.
//
// These are behavioural assertions through the real termination seam (not source-text
// scans), so they fail if the log line is removed OR if it stops carrying the fields
// that made the 2026-09-11 investigation possible.

const testTmpDir = join(tmpdir(), `adhdev-sesslifecycle-${randomUUID().slice(0, 8)}`);
const testConfigDir = join(testTmpDir, '.adhdev');

vi.mock('../../src/config/config.js', () => ({
    getConfigDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    getDaemonDataDir: () => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        return testConfigDir;
    },
    loadConfig: () => ({ machineId: 'mach_1b46842a15d3409d96ad33e767a916dd' }),
    getMachineId: () => 'mach_1b46842a15d3409d96ad33e767a916dd',
    getMachineNickname: () => null,
}));

import { LOG } from '../../src/logging/logger.js';
import { handleSessionTerminationObservation } from '../../src/mesh/mesh-termination-bridge.js';
import type { SessionTermination } from '@adhdev/session-host-core';

/** The exact shape of the 2026-09-11 coordinator death: exit 143, no explicit signal. */
function sigtermTombstone(overrides: Partial<SessionTermination> = {}): SessionTermination {
    return {
        exitCode: 143,
        signal: 0,
        reason: 'exit',
        lifecycle: 'stopped',
        terminatedAt: Date.now(),
        previousLifecycle: 'running',
        osPid: 19223,
        ...overrides,
    } as SessionTermination;
}

describe('session lifecycle reaches the daemon log (defect 1)', () => {
    let lines: string[];
    let spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        if (!existsSync(testConfigDir)) mkdirSync(testConfigDir, { recursive: true });
        lines = [];
        spy = vi.spyOn(LOG, 'info').mockImplementation((subsystem: string, message: string) => {
            lines.push(`${subsystem}|${message}`);
        });
    });
    afterEach(() => spy.mockRestore());

    const lifecycleLines = () => lines.filter(l => l.startsWith('SessionLifecycle|'));

    it('logs a coordinator session END with the fields the investigation needed', async () => {
        await handleSessionTerminationObservation({
            sessionId: 'sess_6b290e86',
            providerType: 'claude',
            workspace: '/tmp/ws',
            // A COORDINATOR binds via meshCoordinatorFor — the death that motivated
            // this fix WAS the coordinator, so this is the case that must be covered.
            runtimeSettings: { meshCoordinatorFor: 'mesh_abc123' },
            termination: sigtermTombstone(),
        });

        const line = lifecycleLines().find(l => l.includes('Session ENDED'));
        expect(line, 'a session end must be logged to the daemon log').toBeTruthy();
        expect(line).toContain('session=sess_6b290e86');
        expect(line).toContain('provider=claude');
        expect(line).toContain('mesh=mesh_abc123');
        // The single most load-bearing distinction: the mesh lost its DRIVER, not a worker.
        expect(line).toContain('coordinatorSession=true');
        // 143 decoded to SIGTERM — the grep that returned zero hits was for this word.
        expect(line).toContain('signal=SIGTERM');
        expect(line).toContain('exitCode=143');
        expect(line).toContain('reason=external_signal');
        // The pid that lets an external process record be joined against this death.
        expect(line).toContain('osPid=19223');
    });

    it('names the origin path when the daemon itself requested the stop', async () => {
        // Defect 1 explicitly asks for daemon-originated stops to name their path. This
        // also pins that the log is NOT gated by the ledger's requestedStop guard — that
        // guard exists only to avoid a duplicate LEDGER row, and suppressing the log line
        // with it would hide exactly the case an operator most needs ("who killed it?").
        await handleSessionTerminationObservation({
            sessionId: 'sess_worker_1',
            providerType: 'codex',
            runtimeSettings: { meshNodeFor: 'mesh_abc123', meshNodeId: 'node_e05a4e57' },
            termination: sigtermTombstone({ requestedStop: 'stop', exitCode: 0, signal: 0 }),
        });

        const line = lifecycleLines().find(l => l.includes('Session ENDED'));
        expect(line, 'a daemon-requested stop must still be logged').toBeTruthy();
        expect(line).toContain('stopRequestedVia=stop');
        expect(line).toContain('reason=host_requested_stop');
        expect(line).toContain('intentional=true');
        // A worker, not the coordinator — and its node is identified.
        expect(line).toContain('coordinatorSession=false');
        expect(line).toContain('node=node_e05a4e57');
    });

    it('never puts chat or agent content in the log line', async () => {
        // ★Content boundary. A log file is not a content sink: even though the
        // observation carries runtimeSettings wholesale, nothing free-text may be
        // emitted. This fails if someone later interpolates a summary or message.
        await handleSessionTerminationObservation({
            sessionId: 'sess_content_probe',
            providerType: 'claude',
            runtimeSettings: {
                meshCoordinatorFor: 'mesh_abc123',
                lastAgentMessage: 'SECRET-CHAT-CONTENT-DO-NOT-LOG',
                systemPrompt: 'SECRET-PROMPT-DO-NOT-LOG',
            },
            termination: sigtermTombstone(),
        });

        const joined = lifecycleLines().join('\n');
        expect(joined).not.toContain('SECRET-CHAT-CONTENT-DO-NOT-LOG');
        expect(joined).not.toContain('SECRET-PROMPT-DO-NOT-LOG');
    });

    it('stays silent for a session with no mesh binding', async () => {
        // An ordinary non-mesh CLI session must not start writing mesh lifecycle lines —
        // the bridge's existing "write nothing" contract is unchanged by the log.
        await handleSessionTerminationObservation({
            sessionId: 'sess_plain',
            providerType: 'claude',
            runtimeSettings: {},
            termination: sigtermTombstone(),
        });

        expect(lifecycleLines()).toHaveLength(0);
    });
});
