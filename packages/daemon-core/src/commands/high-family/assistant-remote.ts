/**
 * Host side of a remote-hosted assistant project (owner decision 2026-10-08,
 * closing design Q4 of docs/design/2026-10-07-assistant-layer.md): another
 * daemon's assistant drives a mesh THIS daemon hosts by relaying here.
 *
 * One verb, `assistant_remote_project {meshId, op, …}`, ops:
 *   - `status` — the `project_status` body (assistant.ts `localProjectStatus`);
 *   - `send`   — ensure a coordinator here + `send_chat` (origin `assistant`,
 *                queue) of the text the caller composed (`localProjectSend`).
 *                No thread opens HERE: the caller's assistant owns it;
 *   - `read`   — the `project_read` body (`localProjectRead`);
 *   - `poll`   — the coordinator's turns this daemon's ledger committed after
 *                the caller's cursor, the coordinator's latest reply, open /
 *                modal state, content-free work counts and `[Mesh]` line;
 *   - `note`   — record / forget an operating note. The caller already
 *                classified the origin and applied its staging rules; the
 *                text checks run again here (defence in depth).
 *
 * ─── Who may call it (security) ─────────────────────────────────────────
 * Source `mesh` ONLY: it is reachable solely through the daemon↔daemon mesh
 * transport, never from the dashboard, the HTTP API or an MCP server on this
 * daemon. The router's mesh-sender gate runs first with class `roster`: the
 * transport-stamped (authenticated) sender must be on the roster of the named
 * mesh in THIS daemon's own mesh record — the host's meshes.json, which is
 * authoritative; ids in the payload are claims. The handler then requires that
 * this daemon actually hosts that mesh (a roster from an `inlineMesh` the
 * payload carried is never enough). It never takes a session id: the only
 * session it writes to is the coordinator of that one mesh, picked here
 * (`ensureCoordinator`), so a roster member cannot reach any other session.
 *
 * What this grants beyond the existing mesh trust: a roster member can put
 * text into the mesh's coordinator — the owner's decision (manage every
 * reachable project). Every peer is a daemon of the same account (cloud: the
 * server pairs only same-account daemons; standalone: the pairing code
 * admitted it), and a member already runs code its coordinator dispatches.
 * The text enters with origin `assistant` (the coordinator's prompt frames it
 * as relayed instructions), each send/note logs the sender here, and a
 * revoked/removed member drops off the roster and is refused.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { componentsNotReadyResult, isDaemonComponentsNotReady } from '../daemon-components-port.js';
import { readMeshSender } from '../mesh-sender.js';
import type { CommandRouterResult } from '../router.js';
import type { HighFamilyContext, HighFamilyHandler } from './types.js';
import { LOG } from '../../logging/logger.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { pickCoordinator } from '../../assistant/coordinator-lifecycle.js';
import { compactTranscriptTail, coordinatorState } from '../../assistant/project-views.js';
import { ASSISTANT_REMOTE_PROJECT_COMMAND, ASSISTANT_REMOTE_OPS, type AssistantRemoteOp } from '../../assistant/assistant-remote-host.js';
import type { AssistantProjectPorts } from '../../assistant/assistant-project-ports.js';
import { localProjectRead, localProjectSend, localProjectStatus, readTailArg } from './assistant.js';
import { applyNote, noteTextRefusal, parseNoteOp, projectPortsFor } from './assistant-store.js';

/** Largest composed text a remote send carries (the caller composes; skills are capped at 12 k there). */
export const REMOTE_SEND_MAX_CHARS = 64_000;
/** Commits returned per poll (older ones fold into the relay's "earlier turns"). */
export const REMOTE_POLL_MAX_COMMITS = 5;

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function fail(code: string, error: string = code, extra: Record<string, unknown> = {}): CommandRouterResult {
    return { success: false, code, error, ...extra };
}

/** The coordinator's latest assistant-role bubble (the same projection a local relay reads). */
async function coordinatorTail(ports: AssistantProjectPorts, sessionId: string): Promise<string | null> {
    const chat = await ports.execute('read_chat', { targetSessionId: sessionId, limit: 40 });
    if (!chat.success) return null;
    const messages = (compactTranscriptTail(chat, 20).messages as Array<{ role: string; text: string }>) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return messages[i]!.text;
    return null;
}

async function poll(ports: AssistantProjectPorts, meshId: string, args: Record<string, unknown>): Promise<CommandRouterResult> {
    const views = ports.coordinators(meshId);
    const live = pickCoordinator(views);
    const queue = ports.queueCounts(meshId);
    const missions = ports.activeMissionCount(meshId);
    const work = queue ? { activeMissions: missions ?? 0, pending: queue.pending, assigned: queue.assigned } : null;
    const statusLine = ports.meshStatusLine(meshId);
    const sessionId = live?.sessionId ?? ports.lastCoordinatorSessionId(meshId);
    if (!sessionId) {
        return { success: true, coordinator: 'none', coordinatorSessionId: null, open: false, modal: false, commits: [], cursor: null, cursorFound: false, work, statusLine };
    }
    const turns = ports.coordinatorTurns(sessionId, REMOTE_POLL_MAX_COMMITS);
    const after = str(args.afterAttemptId);
    const idx = after ? turns.committed.findIndex((c) => c.attemptId === after) : -1;
    const fresh = idx >= 0 ? turns.committed.slice(0, idx) : turns.committed;
    const now = Date.now();
    const commits = fresh.slice().reverse().map((c) => ({ attemptId: c.attemptId, outcome: c.outcome, ageMs: Math.max(0, now - c.at) }));
    return {
        success: true,
        coordinator: coordinatorState(views),
        coordinatorSessionId: sessionId,
        open: turns.open,
        modal: !!live?.modalParked,
        commits,
        cursor: turns.committed[0]?.attemptId ?? null,
        cursorFound: idx >= 0,
        ...(commits.length ? { body: await coordinatorTail(ports, sessionId) } : {}),
        work,
        statusLine,
    };
}

async function note(meshId: string, args: Record<string, unknown>): Promise<CommandRouterResult> {
    const op = parseNoteOp(args);
    if (typeof op === 'string') return fail('invalid_args', op);
    // Only the origins that APPLY reach the host (staging stays with the caller).
    const origin = str(args.origin);
    if (origin !== 'human' && origin !== 'owner') return fail('invalid_args', 'origin must be human or owner');
    const refusal = noteTextRefusal(op.text);
    if (refusal) return fail(refusal.result, refusal.result, refusal.pattern ? { pattern: refusal.pattern } : {});
    const callerSessionId = str(args.callerSessionId);
    const applied = await applyNote(getAssistantServices(), meshId, op, origin, callerSessionId || undefined);
    return { success: true, ...applied };
}

async function run(ports: AssistantProjectPorts, op: AssistantRemoteOp, meshId: string, args: Record<string, unknown>): Promise<CommandRouterResult> {
    const mesh = ports.listMeshes().find((m) => m.id === meshId)!;
    switch (op) {
        case 'status':
            return { success: true, result: await localProjectStatus(ports, mesh) };
        case 'send': {
            const text = typeof args.text === 'string' ? args.text : '';
            if (!text.trim()) return fail('invalid_args', 'text required');
            if (text.length > REMOTE_SEND_MAX_CHARS) return fail('invalid_args', `text over ${REMOTE_SEND_MAX_CHARS} characters`);
            const clientId = str(args.clientId);
            if (!clientId || clientId.length > 200) return fail('invalid_args', 'clientId required (at most 200 characters)');
            const sent = await localProjectSend(ports, mesh, text, clientId);
            if (!sent.ok) return fail(sent.code, sent.error, sent.detail);
            const { ok: _ok, ...result } = sent;
            return { success: true, result };
        }
        case 'read': {
            const r = await localProjectRead(ports, meshId, readTailArg(args.tail));
            return r.ok ? { success: true, result: r.result } : fail('project_read_failed', r.error, { coordinatorSessionId: r.coordinatorSessionId });
        }
        case 'poll':
            return poll(ports, meshId, args);
        case 'note':
            return note(meshId, args);
    }
}

const assistantRemoteProject: HighFamilyHandler = async (ctx: HighFamilyContext, rawArgs: any) => {
    const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const meshId = str(args.meshId);
    const op = str(args.op) as AssistantRemoteOp;
    if (!meshId) return fail('invalid_args', 'meshId required');
    if (!(ASSISTANT_REMOTE_OPS as readonly string[]).includes(op)) return fail('invalid_args', `op must be one of ${ASSISTANT_REMOTE_OPS.join(', ')}`);
    try {
        const ports = await projectPortsFor(ctx);
        const mesh = ports.listMeshes().find((m) => m.id === meshId);
        if (!mesh) return fail('project_not_found', `mesh ${meshId} is not in this daemon's project inventory`);
        if (!ports.isHostedHere(mesh)) return fail('project_not_hosted_here', `this daemon does not host mesh ${meshId}`);
        const sender = readMeshSender(args);
        const self = ports.selfDaemonId();
        if (op === 'send' || op === 'note') {
            const who = sender && self && daemonIdsEquivalent(sender, self) ? 'self' : sender.slice(0, 24) || 'unknown';
            LOG.info('Assistant', `remote ${op} for mesh ${meshId} from ${who}`);
        }
        return await run(ports, op, meshId, args);
    } catch (e) {
        if (isDaemonComponentsNotReady(e)) return componentsNotReadyResult(e);
        throw e;
    }
};

export const assistantRemoteHandlers: Record<string, HighFamilyHandler> = {
    [ASSISTANT_REMOTE_PROJECT_COMMAND]: assistantRemoteProject,
};

export const assistantRemoteSpecs = defineCommandSpecs('high', assistantRemoteHandlers, {
    [ASSISTANT_REMOTE_PROJECT_COMMAND]: { sources: ['mesh'], meshSender: 'roster' },
});
