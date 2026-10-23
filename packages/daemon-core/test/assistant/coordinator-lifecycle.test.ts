/**
 * ensureCoordinator (design 2026-10-07-assistant-layer.md §4.3 step 2):
 * selection order, the per-mesh mutex, launch stamp/prompt, tab hiding, and
 * launch failures returned with the launch command's own code.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    ASSISTANT_COORDINATOR_EXTRA_PROMPT,
    ensureCoordinator,
    pickCoordinator,
    withMeshLock,
    type AssistantCoordinatorView,
    type EnsureCoordinatorPorts,
} from '../../src/assistant/coordinator-lifecycle.js';

const view = (sessionId: string, over: Partial<AssistantCoordinatorView> = {}): AssistantCoordinatorView => ({
    sessionId, idle: false, modalParked: false, managedByAssistant: false, ...over,
});

function ports(over: Partial<EnsureCoordinatorPorts> = {}): EnsureCoordinatorPorts & { live: AssistantCoordinatorView[] } {
    const live: AssistantCoordinatorView[] = [];
    return {
        live,
        coordinators: () => live,
        launch: vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 5));
            live.push(view('coord-new', { managedByAssistant: true, idle: true }));
            return { success: true, sessionId: 'coord-new' };
        }),
        hide: vi.fn(async () => undefined),
        ...over,
    };
}

describe('pickCoordinator', () => {
    it('managedByAssistant → idle → most recently started', () => {
        expect(pickCoordinator([])).toBeNull();
        expect(pickCoordinator([view('human-idle', { idle: true }), view('managed-busy', { managedByAssistant: true })])?.sessionId).toBe('managed-busy');
        expect(pickCoordinator([view('busy'), view('idle', { idle: true })])?.sessionId).toBe('idle');
        expect(pickCoordinator([view('old', { startedAt: 1 }), view('new', { startedAt: 2 })])?.sessionId).toBe('new');
    });

    it('keeps a live PTY coordinator with parse_error overlay while excluding confirmed terminal candidates', () => {
        const parseErrorLive = view('coord-parse-error', {
            idle: true,
            managedByAssistant: true,
            status: 'error',
            errorReason: 'parse_error',
            connected: true,
            disposed: false,
            adapterAlive: true,
            rawAdapterStatus: 'idle',
            runtime: { runtimeId: 'coord-parse-error', lifecycle: 'running', surfaceKind: 'live_runtime' },
        } as any);
        const terminalStopped = view('coord-stopped', { idle: true, managedByAssistant: true, status: 'stopped' } as any);
        const terminalRawError = view('coord-raw-error', { idle: true, managedByAssistant: true, status: 'error', rawAdapterStatus: 'error' } as any);
        const terminalDeadPty = view('coord-dead-pty', { idle: true, managedByAssistant: true, adapterAlive: false } as any);
        const terminalSnapshot = view('coord-snapshot', {
            idle: true,
            managedByAssistant: true,
            runtime: { runtimeId: 'coord-snapshot', lifecycle: 'stopped', surfaceKind: 'recovery_snapshot' },
        } as any);

        expect(pickCoordinator([terminalStopped, terminalRawError, terminalDeadPty, terminalSnapshot])).toBeNull();
        expect(pickCoordinator([terminalStopped, parseErrorLive])?.sessionId).toBe('coord-parse-error');
    });
});

describe('ensureCoordinator', () => {
    it('reuses a live coordinator without launching', async () => {
        const p = ports();
        p.live.push(view('human', { idle: true }));
        expect(await ensureCoordinator('mesh_a', p)).toEqual({ ok: true, sessionId: 'human', launched: false, managedByAssistant: false });
        expect(p.launch).not.toHaveBeenCalled();
    });

    it('launches with the managed stamp, the fixed prompt and daemon-resolved defaults, then hides the tab', async () => {
        const p = ports();
        expect(await ensureCoordinator('mesh_a', p)).toEqual({ ok: true, sessionId: 'coord-new', launched: true, managedByAssistant: true });
        expect(p.launch).toHaveBeenCalledWith({ meshId: 'mesh_a', extraSystemPrompt: ASSISTANT_COORDINATOR_EXTRA_PROMPT, managedByAssistant: true });
        expect(p.hide).toHaveBeenCalledWith('coord-new');
        // The assistant guidance moved into the base coordinator prompt (it must reach
        // reused, user-started coordinators too), so the launch adds nothing.
        expect(ASSISTANT_COORDINATOR_EXTRA_PROMPT).toBe('');
    });

    it('two concurrent sends for one mesh launch exactly one coordinator', async () => {
        const p = ports();
        const [a, b] = await Promise.all([ensureCoordinator('mesh_a', p), ensureCoordinator('mesh_a', p)]);
        expect(p.launch).toHaveBeenCalledTimes(1);
        expect(a).toMatchObject({ ok: true, sessionId: 'coord-new', launched: true });
        expect(b).toMatchObject({ ok: true, sessionId: 'coord-new', launched: false });
    });

    it('returns the launch failure code unchanged and does not hide', async () => {
        const p = ports({
            launch: vi.fn(async () => ({ success: false, code: 'mesh_coordinator_manual_mcp_setup_required', error: 'needs setup', cliType: 'x' })),
        });
        expect(await ensureCoordinator('mesh_a', p)).toEqual({
            ok: false, code: 'mesh_coordinator_manual_mcp_setup_required', error: 'needs setup', detail: { cliType: 'x' },
        });
        expect(p.hide).not.toHaveBeenCalled();
    });

    it('a hide failure does not fail the send precondition', async () => {
        const p = ports({ hide: vi.fn(async () => { throw new Error('nope'); }) });
        expect(await ensureCoordinator('mesh_a', p)).toMatchObject({ ok: true, launched: true });
    });
});

describe('withMeshLock', () => {
    it('serializes per mesh and keeps running after a rejection', async () => {
        const order: string[] = [];
        const slow = withMeshLock('m', async () => { await new Promise((r) => setTimeout(r, 10)); order.push('a'); throw new Error('x'); });
        const next = withMeshLock('m', async () => { order.push('b'); return 1; });
        const other = withMeshLock('n', async () => { order.push('c'); return 2; });
        await expect(slow).rejects.toThrow('x');
        expect(await next).toBe(1);
        expect(await other).toBe(2);
        expect(order).toEqual(['c', 'a', 'b']);
    });
});
