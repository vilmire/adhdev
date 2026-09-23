/**
 * Standalone `status_event` over the dashboard WS (wiring-unification B5,
 * checklist item 3) and the IPC / HTTP → metadata push (item 8).
 *
 * The standalone transport is fed by the SAME status-event emitter cloud uses
 * (daemon-core status/status-event.ts): provider_event on the bus → the
 * allow-listed projection → one `status_event` frame per OPEN dashboard socket.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// daemon-core's logger resolves the config dir at import time and refuses the
// developer's live state dir in a test runtime — pin a tmp dir BEFORE loading it.
process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-status-event-'));

let createSessionLifecycleBus: typeof import('../../daemon-core/src/sessions/lifecycle-bus.js').createSessionLifecycleBus;
let createStatusEventEmitter: typeof import('../../daemon-core/src/status/status-event.js').createStatusEventEmitter;
let createStandaloneHostTransport: typeof import('../src/standalone-host-transport.js').createStandaloneHostTransport;

beforeAll(async () => {
  ({ createSessionLifecycleBus } = await import('../../daemon-core/src/sessions/lifecycle-bus.js'));
  ({ createStatusEventEmitter } = await import('../../daemon-core/src/status/status-event.js'));
  ({ createStandaloneHostTransport } = await import('../src/standalone-host-transport.js'));
});

const OPEN = 1;
const CLOSED = 3;

function fakeWs(readyState: number) {
  const frames: any[] = [];
  return { readyState, frames, send: (raw: string) => frames.push(JSON.parse(raw)) };
}

function setup() {
  const open = fakeWs(OPEN);
  const closed = fakeWs(CLOSED);
  const scheduleBroadcastStatus = vi.fn();
  const transport = createStandaloneHostTransport({
    statusInstanceId: 'standalone_mach_test',
    version: 'test',
    clients: new Set([open, closed]) as any,
    wsByConnectionId: new Map(),
    chatTail: { flush: vi.fn(async () => {}), onPrepared: vi.fn() } as any,
    getRuntime: () => null,
    getSessionHostControl: () => null,
    scheduleBroadcastStatus,
  });
  const bus = createSessionLifecycleBus();
  createStatusEventEmitter(bus, {
    instanceManager: null,
    sendDashboard: (payload) => transport.sendStatusEvent(payload),
    ...(transport.sendServerStatusEvent ? { sendServer: (p: any) => transport.sendServerStatusEvent!(p) } : {}),
  });
  return { open, closed, transport, bus, scheduleBroadcastStatus };
}

describe('standalone status_event over WS', () => {
  it('delivers an approval event as an allow-listed status_event frame to every OPEN socket', () => {
    const { open, closed, bus } = setup();
    bus.emit({
      kind: 'provider_event',
      sessionId: 's1',
      at: 1,
      event: {
        event: 'agent:waiting_approval',
        providerType: 'claude-cli',
        targetSessionId: 's1',
        timestamp: 100,
        modalMessage: 'rm -rf build/',
        modalButtons: ['Yes', 'No'],
        interactivePrompt: { promptId: 'p1', questions: [] },
        promptId: 'p1',
        // Content the projection must never carry:
        finalSummary: 'the full assistant transcript',
        chatTitle: 'private chat title',
      } as any,
    });

    expect(closed.frames).toEqual([]);
    expect(open.frames).toHaveLength(1);
    const frame = open.frames[0];
    expect(frame.type).toBe('status_event');
    expect(typeof frame.timestamp).toBe('number');
    expect(frame.payload).toEqual({
      event: 'agent:waiting_approval',
      timestamp: 100,
      targetSessionId: 's1',
      providerType: 'claude-cli',
      modalMessage: 'rm -rf build/',
      modalButtons: ['Yes', 'No'],
      // Dashboard copy only (never on a server leg):
      interactivePrompt: { promptId: 'p1', questions: [] },
      promptId: 'p1',
    });
  });

  it('drops provider:* UI effects and unknown event names, and has no server leg', () => {
    const { open, bus, transport } = setup();
    expect(transport.sendServerStatusEvent).toBeUndefined();
    bus.emit({ kind: 'provider_event', sessionId: 's1', at: 1, event: { event: 'provider:toast', message: 'hello', timestamp: 1 } as any });
    bus.emit({ kind: 'provider_event', sessionId: 's1', at: 1, event: { event: 'agent:ready', timestamp: 1 } as any });
    expect(open.frames).toEqual([]);
  });

  it('pushes the status snapshot for a command that invalidates daemon.metadata or fast-flushes (any entry — C11)', () => {
    const { transport, scheduleBroadcastStatus } = setup();
    const base = { kind: 'command_executed', at: 0, success: true, postChat: false, interactionId: 'i' } as const;
    transport.onCommandExecuted!({ ...base, command: 'read_chat', source: 'ipc', invalidates: new Set(), fastFlush: false } as any);
    expect(scheduleBroadcastStatus).not.toHaveBeenCalled();
    transport.onCommandExecuted!({ ...base, command: 'stop_cli', source: 'ipc', invalidates: new Set(['daemon.metadata']), fastFlush: false } as any);
    expect(scheduleBroadcastStatus).toHaveBeenCalledTimes(1);
    transport.onCommandExecuted!({ ...base, command: 'interactive_prompt_response', source: 'standalone', invalidates: new Set(), fastFlush: true } as any);
    expect(scheduleBroadcastStatus).toHaveBeenCalledTimes(2);
  });
});
