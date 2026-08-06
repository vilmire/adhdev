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

  // ── Per-launch override (coordinator-launch dialog approval-mode picker) ──
  it('a per-launch mode override wins over the repo mesh.json providerDefaults mode', () => {
    // override='danger' beats repoConfig('accept-edits'); 'danger' carries a known-dangerous
    // launchArg, so without delegatedWorkerDangerousModeAllow it downgrades to the safe
    // pty-parse fallback ('parsed') rather than silently falling through to 'accept-edits'.
    expect(
      resolveDelegatedWorkerAutoApprove(
        DEFAULT_MESH_POLICY, undefined, modeProvider, repoConfig('accept-edits'), 'claude-cli', 'danger',
      ),
    ).toBe('parsed');
    // With machine-local opt-in, the override-selected dangerous mode is honored.
    expect(
      resolveDelegatedWorkerAutoApprove(
        { ...DEFAULT_MESH_POLICY, delegatedWorkerDangerousModeAllow: true },
        undefined, modeProvider, repoConfig('accept-edits'), 'claude-cli', 'danger',
      ),
    ).toBe('danger');
  });

  it('a per-launch mode override selects a specific declared mode over the provider spec default', () => {
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, undefined, undefined, 'accept-edits'),
    ).toBe('accept-edits');
    // No override, no repo config, no providerType → provider spec default.
    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider)).toBe('parsed');
  });

  it('an unknown per-launch override mode id falls back to the provider default (fail-closed)', () => {
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, undefined, undefined, 'does-not-exist'),
    ).toBe('parsed');
  });

  it('PRIORITY INVERSION GUARD: node/mesh ENABLE=false wins over a per-launch mode override too', () => {
    expect(
      resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: false }, undefined, modeProvider, undefined, undefined, 'accept-edits',
      ),
    ).toBe(false);
  });

  it('delegatedWorkerAutoApproveSettings threads the mode override through to the settings envelope', () => {
    expect(delegatedWorkerAutoApproveSettings(
      DEFAULT_MESH_POLICY, undefined, modeProvider, undefined, undefined, 'accept-edits',
    )).toEqual({
      autoApprove: undefined,
      autoApproveMode: 'accept-edits',
      delegatedWorkerDangerousModeAllow: false,
    });
  });

  it('a per-launch legacy boolean override is honored for providers with no declared modes', () => {
    // No provider.autoApproveModes → legacy boolean branch.
    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, null, undefined, undefined, undefined, false)).toBe(false);
    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, null, undefined, undefined, undefined, true)).toBe(true);
    // Omitted override → defaults to enabled (existing behavior).
    expect(resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, null)).toBe(true);
  });

  it('the legacy boolean override is ignored once the provider declares modes', () => {
    // overrideLegacyAutoApprove=false must NOT suppress a mode-based provider — only
    // overrideModeId (or repo/provider defaults) govern mode selection.
    expect(
      resolveDelegatedWorkerAutoApprove(DEFAULT_MESH_POLICY, undefined, modeProvider, undefined, undefined, undefined, false),
    ).toBe('parsed');
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
