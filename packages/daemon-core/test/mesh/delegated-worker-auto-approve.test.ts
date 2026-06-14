import { describe, it, expect } from 'vitest';

import {
  DEFAULT_MESH_POLICY,
  resolveDelegatedWorkerAutoApprove,
} from '../../src/repo-mesh-types.js';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';

describe('resolveDelegatedWorkerAutoApprove', () => {
  it('defaults delegated worker sessions to auto-approve when no policy is set', () => {
    expect(resolveDelegatedWorkerAutoApprove(undefined, undefined)).toBe(true);
    expect(resolveDelegatedWorkerAutoApprove(null, null)).toBe(true);
    expect(resolveDelegatedWorkerAutoApprove({}, {})).toBe(true);
  });

  it('honors the mesh-level policy opt-out', () => {
    expect(resolveDelegatedWorkerAutoApprove({ delegatedWorkerAutoApprove: false }, undefined)).toBe(false);
    expect(resolveDelegatedWorkerAutoApprove({ delegatedWorkerAutoApprove: true }, undefined)).toBe(true);
  });

  it('lets a node policy override the mesh-level policy', () => {
    // node says false, mesh says true → node wins
    expect(
      resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: true },
        { delegatedWorkerAutoApprove: false },
      ),
    ).toBe(false);
    // node says true, mesh says false → node wins
    expect(
      resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: false },
        { delegatedWorkerAutoApprove: true },
      ),
    ).toBe(true);
  });

  it('DEFAULT_MESH_POLICY enables delegated worker auto-approve', () => {
    expect(DEFAULT_MESH_POLICY.delegatedWorkerAutoApprove).toBe(true);
    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined)).toBe(true);
  });
});

describe('delegated worker launch envelope → shouldAutoApprove() precedence', () => {
  // Mirrors cli-manager.ts: this.settings = { ...providerLoader.getSettings(type), ...settingsOverride }
  function mergeLaunchSettings(
    providerGlobalSettings: Record<string, any>,
    launchEnvelope: Record<string, any>,
  ): Record<string, any> {
    return { ...providerGlobalSettings, ...launchEnvelope };
  }

  it('worker envelope autoApprove=true wins over a global per-provider-type autoApprove=false', () => {
    // Global per-provider-type config has auto-approve OFF (the buggy condition that
    // used to leak an approval notification for delegated workers).
    const providerGlobalSettings = { enabled: true, autoApprove: false };
    // The mesh worker launch envelope (what mesh-tools.ts / mesh-events-coordinator.ts stamp)
    // becomes settingsOverride in cli-manager.ts and is merged on top of the global settings.
    const workerEnvelope = {
      role: 'worker',
      meshNodeFor: 'mesh-1',
      meshNodeId: 'node-1',
      launchedByCoordinator: true,
      autoApprove: resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined),
    };

    const instance = new CliProviderInstance(
      {
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        spawn: { command: 'claude', args: [] },
      } as any,
      '/tmp/project',
      [],
      'runtime-session-delegated-worker',
    ) as any;
    instance.settings = mergeLaunchSettings(providerGlobalSettings, workerEnvelope);

    expect(instance.settings.autoApprove).toBe(true);
    expect(instance.shouldAutoApprove()).toBe(true);
  });

  it('a node-level opt-out propagates an autoApprove=false envelope that disables auto-approve', () => {
    const providerGlobalSettings = { enabled: true, autoApprove: true };
    const workerEnvelope = {
      role: 'worker',
      meshNodeFor: 'mesh-1',
      meshNodeId: 'node-1',
      launchedByCoordinator: true,
      autoApprove: resolveDelegatedWorkerAutoApprove(
        DEFAULT_MESH_POLICY,
        { delegatedWorkerAutoApprove: false },
      ),
    };

    const instance = new CliProviderInstance(
      {
        type: 'claude-cli',
        name: 'Claude Code',
        category: 'cli',
        spawn: { command: 'claude', args: [] },
      } as any,
      '/tmp/project',
      [],
      'runtime-session-delegated-worker-optout',
    ) as any;
    instance.settings = mergeLaunchSettings(providerGlobalSettings, workerEnvelope);

    expect(instance.settings.autoApprove).toBe(false);
    expect(instance.shouldAutoApprove()).toBe(false);
  });
});
