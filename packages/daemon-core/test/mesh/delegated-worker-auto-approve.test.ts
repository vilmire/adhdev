import { describe, it, expect } from 'vitest';

import {
  DEFAULT_MESH_POLICY,
  delegatedWorkerAutoApproveSettings,
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

  it('downgrades a dangerous provider default to PTY parsing unless explicitly allowed', () => {
    const provider = {
      autoApproveModes: {
        default: 'danger',
        modes: [
          { id: 'parsed', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
          {
            id: 'danger',
            label: 'Danger',
            strategy: 'launch-args',
            risk: 'safe',
            warning: 'Sandbox and approval checks are bypassed.',
            launchArgs: ['--dangerously-bypass-approvals-and-sandbox'],
          },
        ],
      },
    } as any;

    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, provider)).toBe('parsed');
    expect(resolveDelegatedWorkerAutoApprove(
      { ...DEFAULT_MESH_POLICY, delegatedWorkerDangerousModeAllow: true },
      undefined,
      provider,
    )).toBe('danger');
    expect(resolveDelegatedWorkerAutoApprove(
      { ...DEFAULT_MESH_POLICY, delegatedWorkerDangerousModeAllow: true },
      { delegatedWorkerDangerousModeAllow: false },
      provider,
    )).toBe('parsed');
    expect(DEFAULT_MESH_POLICY.delegatedWorkerDangerousModeAllow).toBe(false);
  });

  // ── repo mesh.json providerDefaults (MODE selection only, never ENABLE) ──
  const modeProvider = {
    autoApproveModes: {
      default: 'parsed',
      modes: [
        { id: 'parsed', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
        { id: 'accept-edits', label: 'Accept edits', strategy: 'launch-args', risk: 'safe', launchArgs: ['--accept-edits'] },
        {
          id: 'danger',
          label: 'Danger',
          strategy: 'launch-args',
          risk: 'safe',
          launchArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        },
      ],
    },
  } as any;

  const repoConfig = (modeId: string) => ({
    version: 1 as const,
    providerDefaults: { autoApproveModes: { 'claude-cli': modeId } },
  });

  it('adopts a repo mesh.json requested mode over the provider spec default when enabled', () => {
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, repoConfig('accept-edits'), 'claude-cli'),
    ).toBe('accept-edits');
    // No repoConfig / no providerType → provider spec default.
    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider)).toBe('parsed');
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, repoConfig('accept-edits'), 'other-cli'),
    ).toBe('parsed');
  });

  it('PRIORITY INVERSION GUARD: node/mesh ENABLE=false wins over any repo-requested mode', () => {
    // node false, repo requests a mode → still false (repo never re-enables).
    expect(
      resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: true },
        { delegatedWorkerAutoApprove: false },
        modeProvider,
        repoConfig('accept-edits'),
        'claude-cli',
      ),
    ).toBe(false);
    // mesh false → still false.
    expect(
      resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: false },
        undefined,
        modeProvider,
        repoConfig('accept-edits'),
        'claude-cli',
      ),
    ).toBe(false);
  });

  it('ignores an unknown/stale repo mode id and falls back to the provider default (fail-closed)', () => {
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, repoConfig('does-not-exist'), 'claude-cli'),
    ).toBe('parsed');
  });

  it('downgrades a repo-requested DANGEROUS mode to PTY parsing without a machine opt-in', () => {
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, repoConfig('danger'), 'claude-cli'),
    ).toBe('parsed');
    // With machine-local opt-in, the repo-requested dangerous mode is honored.
    expect(
      resolveDelegatedWorkerAutoApprove(
        { ...DEFAULT_MESH_POLICY, delegatedWorkerDangerousModeAllow: true },
        undefined,
        modeProvider,
        repoConfig('danger'),
        'claude-cli',
      ),
    ).toBe('danger');
  });

  it('clears the opposite settings key so global mode precedence cannot bypass mesh policy', () => {
    expect(delegatedWorkerAutoApproveSettings(
      { ...DEFAULT_MESH_POLICY, delegatedWorkerAutoApprove: false },
      undefined,
    )).toEqual({
      autoApprove: false,
      autoApproveMode: undefined,
      delegatedWorkerDangerousModeAllow: false,
    });
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
