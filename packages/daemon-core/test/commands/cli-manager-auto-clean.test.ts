import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonCliManager } from '../../src/commands/cli-manager.js';

// AUTO-CLEAN used to exist twice in cli-manager (exit monitor: 5s, full teardown,
// `adapters.has(key)`; InstanceManager-less fallback: 3s, partial teardown,
// identity check). The unified scheduleAutoClean must keep the full teardown AND
// the identity check — a session relaunched under the same key inside the grace
// window must not be reclaimed by its predecessor's timer.
describe('DaemonCliManager.scheduleAutoClean', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => {
    const removeInstance = vi.fn();
    const unregisterByInstanceKey = vi.fn();
    const flush = vi.fn(() => true);
    const deps = {
      getInstanceManager: () => ({ getInstance: () => ({ flushMeshCompletionBeforeCleanup: flush }), removeInstance }),
      getSessionRegistry: () => ({ unregisterByInstanceKey }),
      removeAgentTracking: vi.fn(),
      onStatusChange: vi.fn(),
    };
    const manager = Object.create(DaemonCliManager.prototype) as any;
    manager.deps = deps;
    manager.adapters = new Map();
    return { manager, deps, removeInstance, unregisterByInstanceKey, flush };
  };

  it('reclaims the session fully after the grace window, flushing a pending mesh completion first', () => {
    const { manager, deps, removeInstance, unregisterByInstanceKey, flush } = make();
    const adapter = { cliType: 'claude-cli' };
    manager.adapters.set('sess', adapter);

    manager.scheduleAutoClean('sess', adapter, 'error');
    vi.advanceTimersByTime(4_999);
    expect(manager.adapters.has('sess')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(manager.adapters.has('sess')).toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(deps.removeAgentTracking).toHaveBeenCalledWith('sess');
    expect(unregisterByInstanceKey).toHaveBeenCalledWith('sess');
    expect(removeInstance).toHaveBeenCalledWith('sess');
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(removeInstance.mock.invocationCallOrder[0]);
    expect(deps.onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('never reclaims a session relaunched under the same key inside the grace window', () => {
    const { manager, removeInstance } = make();
    const dead = { cliType: 'claude-cli' };
    const relaunched = { cliType: 'claude-cli' };
    manager.adapters.set('sess', dead);
    manager.scheduleAutoClean('sess', dead, 'stopped');

    manager.adapters.set('sess', relaunched);
    vi.advanceTimersByTime(60_000);

    expect(manager.adapters.get('sess')).toBe(relaunched);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('is idempotent when several status callbacks schedule it for the same dead adapter', () => {
    const { manager, removeInstance } = make();
    const adapter = { cliType: 'kimi' };
    manager.adapters.set('sess', adapter);
    for (let i = 0; i < 3; i++) manager.scheduleAutoClean('sess', adapter, 'error');
    vi.advanceTimersByTime(10_000);
    expect(removeInstance).toHaveBeenCalledTimes(1);
  });

  it('works without an InstanceManager or session registry (legacy fallback path)', () => {
    const { manager, deps } = make();
    deps.getInstanceManager = () => null as any;
    (deps as any).getSessionRegistry = undefined;
    const adapter = { cliType: 'claude-cli' };
    manager.adapters.set('sess', adapter);
    manager.scheduleAutoClean('sess', adapter, 'stopped');
    vi.advanceTimersByTime(5_000);
    expect(manager.adapters.has('sess')).toBe(false);
  });
});
