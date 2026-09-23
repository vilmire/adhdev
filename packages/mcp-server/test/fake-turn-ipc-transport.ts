/**
 * fake-turn-ipc-transport — shared test fixture for mcp-server tests that
 * exercise a tool now calling one of the C-W6 IPC commands
 * (`../src/ipc/turn-commands.ts`) instead of an in-process store function.
 *
 * Wiring-unification Phase C, workstream C-W6
 * (docs/design/2026-09-23-wiring-unification.md §5 C2 "MCP server" paragraph).
 *
 * WHY A FAKE TRANSPORT, NOT A MOCK OF `transport.command()`: `CommandTransport`
 * (`../src/transports/mode.js`) is `LocalTransport | IpcTransport` — concrete
 * classes, not a plain interface — and a tool's `ctx.transport` must satisfy
 * that type. Rather than stub `transport.command()` to return a canned
 * response per test (which would silently drift from what the real daemon-side
 * handler actually returns, exactly the class of bug this fixture's own
 * decode-envelope fix in turn-commands.ts caught: `dispatch()` used to hand
 * the DAEMON'S OWN `{success, ...}` envelope straight to a `hasOnlyKeys`
 * decoder that rejects it), this fixture dispatches through the REAL
 * daemon-side handler table (`turnLedgerIpcHandlers`,
 * `daemon-core/src/commands/low-family/turn-ledger-ipc.js`) in-process. A
 * test therefore exercises the exact same encode → handler → decode path a
 * live daemon would run, just without a real socket between the two ends —
 * only the mission table underneath is real (file-backed, per-mesh,
 * cleaned up by the caller exactly as the pre-migration tests already did).
 *
 * Every mcp-server test migrating off the store (this file's callers) should
 * reuse this ONE fixture rather than hand-rolling a per-test stub — the C-W6
 * report's DELIVERABLES ask for "one shared fixture" precisely to avoid ~24
 * independently-drifting fakes.
 */

import { turnLedgerIpcHandlers } from '../../daemon-core/src/commands/low-family/turn-ledger-ipc.js';
import type { LowFamilyContext } from '../../daemon-core/src/commands/low-family/types.js';
import type { CommandTransport } from '../src/transports/mode.js';

const EMPTY_LOW_FAMILY_CONTEXT: LowFamilyContext = {
    // `deps`/`getMeshForCommand` are read only by turnObserve/turnCancel/
    // operatorStatus/turnQuery (for `ctx.deps.statusInstanceId`) — mission_upsert
    // and mission_query never touch it (see turn-ledger-ipc.ts). Cast rather
    // than construct a full CommandRouterDeps: a real one needs a live daemon
    // boot, which is exactly what this fixture exists to avoid for tests that
    // only need the mission table.
    deps: {} as LowFamilyContext['deps'],
};

/**
 * Builds a fake `CommandTransport` whose `.command(name, args)` routes the
 * eight C-W6 commands to the real daemon-side handlers in-process, and
 * rejects any other command name (a test that needs a non-turn-ipc command
 * should stub that separately — this fixture is scoped to turn-ipc only).
 */
export function makeFakeTurnIpcTransport(): CommandTransport {
    const fake = {
        async command(type: string, args: Record<string, unknown> = {}): Promise<any> {
            const handler = turnLedgerIpcHandlers[type];
            if (!handler) {
                throw new Error(`makeFakeTurnIpcTransport: no turn-ipc handler registered for '${type}' — this fixture only serves the eight C-W6 commands`);
            }
            return handler(EMPTY_LOW_FAMILY_CONTEXT, args);
        },
        async ping(): Promise<boolean> {
            return true;
        },
    };
    // `CommandTransport` is a class union (`LocalTransport | IpcTransport`), not
    // a plain interface — every existing tool call site only ever calls
    // `.command()`/`.meshCommand()`/`.ping()` through it (duck-typed at the call
    // site despite the nominal type), so this cast is the same shape of
    // workaround the codebase's other transport fakes already use.
    return fake as unknown as CommandTransport;
}
