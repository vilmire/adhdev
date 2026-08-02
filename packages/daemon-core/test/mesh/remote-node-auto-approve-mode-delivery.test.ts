import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadRepoConfigForNode } from '../../src/mesh/mesh-queue-assignment.js';
import { resolveDelegatedWorkerAutoApprove } from '../../src/repo-mesh-types.js';
import {
  resolveDelegatedWorkerAutoApproveModeForLaunch,
} from '../../src/mesh/delegated-worker-mode-delivery.js';

/**
 * REMOTE-NODE-AUTO-APPROVE-MODE-DELIVERY.
 *
 * A repo `.adhdev/mesh.json` that requests `providerDefaults.autoApproveModes`
 * is honored for a LOCAL node (the coordinator can read that workspace) but was
 * silently dropped for a REMOTE node, because the coordinator resolved the mode
 * by reading `node.workspace` on its OWN filesystem — a path that belongs to the
 * worker machine and cannot exist locally.
 */

const CLAUDE_CLI_PROVIDER = {
  autoApproveModes: {
    default: 'pty-parse',
    modes: [
      { id: 'pty-parse', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
      { id: 'auto', label: 'Auto', strategy: 'launch-args', risk: 'safe', launchArgs: ['--permission-mode', 'auto'] },
    ],
  },
} as any;

function writeMeshJson(workspace: string, modes: Record<string, string>): void {
  mkdirSync(join(workspace, '.adhdev'), { recursive: true });
  writeFileSync(
    join(workspace, '.adhdev', 'mesh.json'),
    JSON.stringify({ version: 1, providerDefaults: { autoApproveModes: modes } }, null, 2),
    'utf-8',
  );
}

describe('remote node auto-approve MODE delivery', () => {
  let localWorkspace: string;
  let unrelatedCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    localWorkspace = mkdtempSync(join(tmpdir(), 'adhdev-local-ws-'));
    unrelatedCwd = mkdtempSync(join(tmpdir(), 'adhdev-cwd-'));
    writeMeshJson(localWorkspace, { 'claude-cli': 'auto' });
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    rmSync(localWorkspace, { recursive: true, force: true });
    rmSync(unrelatedCwd, { recursive: true, force: true });
  });

  // A remote node's workspace path does not exist on the coordinator filesystem.
  const REMOTE_WORKSPACE = '/Users/moltbot/Documents/Work/adhdev';

  describe('coordinator-side resolution (the defect)', () => {
    it('REPRO: a remote node workspace is unreadable on the coordinator, so the repo-requested mode is lost', () => {
      // Pin cwd away from any real repo so the loader's cwd fallback cannot mask this.
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);

      const repoConfig = loadRepoConfigForNode({ workspace: REMOTE_WORKSPACE });
      expect(repoConfig).toBeNull();

      const resolved = resolveDelegatedWorkerAutoApprove(
        { delegatedWorkerAutoApprove: true },
        undefined,
        CLAUDE_CLI_PROVIDER,
        repoConfig,
        'claude-cli',
      );
      // The repo asked for 'auto'; the coordinator silently downgrades to the spec default.
      expect(resolved).toBe('pty-parse');
    });

    it('REPRO: the cwd fallback can misattribute the COORDINATOR repo config to a remote node', () => {
      // Coordinator process runs inside its own checkout, which declares a DIFFERENT mode.
      writeMeshJson(unrelatedCwd, { 'claude-cli': 'pty-parse' });
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);

      // The node's own workspace is remote/unreadable, yet a config is returned —
      // sourced from the coordinator's cwd, not the worker's checkout.
      const repoConfig = loadRepoConfigForNode({ workspace: REMOTE_WORKSPACE });
      expect(repoConfig).toBeNull();
    });

    it('local node: the coordinator CAN read the workspace, so the repo mode is honored', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);

      const repoConfig = loadRepoConfigForNode({ workspace: localWorkspace });
      expect(repoConfig?.providerDefaults?.autoApproveModes?.['claude-cli']).toBe('auto');

      expect(
        resolveDelegatedWorkerAutoApprove(
          { delegatedWorkerAutoApprove: true },
          undefined,
          CLAUDE_CLI_PROVIDER,
          repoConfig,
          'claude-cli',
        ),
      ).toBe('auto');
    });
  });

  describe('worker-side re-resolution (the fix)', () => {
    it('re-resolves the repo-requested mode from the WORKER filesystem', () => {
      // The worker daemon reads its OWN checkout at launch time.
      const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
        workspace: localWorkspace,
        providerType: 'claude-cli',
        provider: CLAUDE_CLI_PROVIDER,
        settings: { launchedByCoordinator: true },
      });
      expect(resolved.autoApproveMode).toBe('auto');
      expect(resolved.changed).toBe(true);
      expect(resolved.source).toBe('worker_repo_file');
    });

    it('honors the DANGEROUS gate on the worker side (no machine opt-in → downgrade)', () => {
      const dangerousProvider = {
        autoApproveModes: {
          default: 'pty-parse',
          modes: [
            { id: 'pty-parse', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
            {
              id: 'yolo',
              label: 'Yolo',
              strategy: 'launch-args',
              risk: 'safe',
              launchArgs: ['--dangerously-skip-permissions'],
            },
          ],
        },
      } as any;
      writeMeshJson(localWorkspace, { 'claude-cli': 'yolo' });

      const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
        workspace: localWorkspace,
        providerType: 'claude-cli',
        provider: dangerousProvider,
        settings: { launchedByCoordinator: true },
      });
      expect(resolved.autoApproveMode).toBe('pty-parse');
    });

    it('honors the DANGEROUS opt-in forwarded by the coordinator envelope', () => {
      const dangerousProvider = {
        autoApproveModes: {
          default: 'pty-parse',
          modes: [
            { id: 'pty-parse', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
            {
              id: 'yolo',
              label: 'Yolo',
              strategy: 'launch-args',
              risk: 'safe',
              launchArgs: ['--dangerously-skip-permissions'],
            },
          ],
        },
      } as any;
      writeMeshJson(localWorkspace, { 'claude-cli': 'yolo' });

      const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
        workspace: localWorkspace,
        providerType: 'claude-cli',
        provider: dangerousProvider,
        settings: { launchedByCoordinator: true, delegatedWorkerDangerousModeAllow: true },
      });
      expect(resolved.autoApproveMode).toBe('yolo');
    });

    it('ENABLE=false is never re-enabled by a repo-requested mode', () => {
      // The coordinator resolved ENABLE=false → autoApprove:false, autoApproveMode absent.
      const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
        workspace: localWorkspace,
        providerType: 'claude-cli',
        provider: CLAUDE_CLI_PROVIDER,
        settings: { launchedByCoordinator: true, autoApprove: false },
      });
      expect(resolved.autoApproveMode).toBeUndefined();
      expect(resolved.changed).toBe(false);
      expect(resolved.source).toBe('enable_gate_off');
    });

    it('a node with NO repo config keeps the coordinator-resolved envelope value', () => {
      const emptyWorkspace = mkdtempSync(join(tmpdir(), 'adhdev-empty-ws-'));
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
      try {
        const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
          workspace: emptyWorkspace,
          providerType: 'claude-cli',
          provider: CLAUDE_CLI_PROVIDER,
          settings: { launchedByCoordinator: true, autoApproveMode: 'pty-parse' },
        });
        expect(resolved.autoApproveMode).toBe('pty-parse');
        expect(resolved.changed).toBe(false);
        expect(resolved.source).toBe('no_repo_config');
      } finally {
        rmSync(emptyWorkspace, { recursive: true, force: true });
      }
    });

    it('is a no-op for a session that was NOT launched by a coordinator', () => {
      const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
        workspace: localWorkspace,
        providerType: 'claude-cli',
        provider: CLAUDE_CLI_PROVIDER,
        settings: {},
      });
      expect(resolved.changed).toBe(false);
      expect(resolved.source).toBe('not_delegated');
    });

    it('an unknown/stale repo mode id falls back without overriding the envelope', () => {
      writeMeshJson(localWorkspace, { 'claude-cli': 'does-not-exist' });
      const resolved = resolveDelegatedWorkerAutoApproveModeForLaunch({
        workspace: localWorkspace,
        providerType: 'claude-cli',
        provider: CLAUDE_CLI_PROVIDER,
        settings: { launchedByCoordinator: true, autoApproveMode: 'pty-parse' },
      });
      expect(resolved.autoApproveMode).toBe('pty-parse');
    });
  });
});
