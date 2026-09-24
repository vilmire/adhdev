import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  delegatedWorkerAutoApproveSettingsForNode,
  loadRepoConfigForNode,
  __resetRepoConfigWarnStreaksForTests,
} from '../../src/mesh/mesh-queue-assignment.js';
import { LOG } from '../../src/logging/logger.js';

/**
 * ★2026-09-25 wiring-unification live pass follow-up.
 *
 * On every queue claim for a node whose repo has no `.adhdev/mesh.json` (a
 * scratch repo, or a fresh clone before mesh_write_mesh_json_config), the daemon
 * logged a WARN — "repo mesh.json unreadable from this daemon" — on EVERY claim
 * cycle, forever, because loadRepoConfigForNode() collapsed "no file" (expected,
 * common, per-repo-optional) and "file present but broken" (a real misconfig)
 * into the same null result, and the WARN fired unconditionally on every null.
 *
 * Fix: distinguish absent (no WARN — the config is optional) from
 * present-but-invalid (WARN, but only once per node per invalid streak — a later
 * successful/absent read resets the streak so a real recovery or fresh failure is
 * observable again).
 */

const CLAUDE_CLI_PROVIDER = {
  autoApproveModes: {
    default: 'pty-parse',
    modes: [
      { id: 'pty-parse', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
    ],
  },
} as any;

function writeRawMeshJson(workspace: string, text: string): void {
  mkdirSync(join(workspace, '.adhdev'), { recursive: true });
  writeFileSync(join(workspace, '.adhdev', 'mesh.json'), text, 'utf-8');
}

function writeValidMeshJson(workspace: string): void {
  writeRawMeshJson(workspace, JSON.stringify({ version: 1, providerDefaults: { autoApproveModes: { 'claude-cli': 'auto' } } }, null, 2));
}

describe('repo mesh.json unreadable — absent vs invalid WARN streak', () => {
  let workspace: string;
  let unrelatedCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'adhdev-repocfg-ws-'));
    unrelatedCwd = mkdtempSync(join(tmpdir(), 'adhdev-repocfg-cwd-'));
    // Pin cwd away from any real repo so the loader's cwd fallback (which would
    // otherwise pick up THIS repo's own .adhdev/mesh.json while tests run inside
    // the monorepo checkout) cannot mask what we're testing.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    warnSpy = vi.spyOn(LOG, 'warn').mockImplementation(() => undefined);
    __resetRepoConfigWarnStreaksForTests();
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    warnSpy.mockRestore();
    __resetRepoConfigWarnStreaksForTests();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(unrelatedCwd, { recursive: true, force: true });
  });

  const node = () => ({ id: 'node_test', workspace });

  it('absent mesh.json: no WARN, and the claim proceeds with provider defaults', () => {
    // No .adhdev/mesh.json written at all — the legitimate, common "not declared" state.
    const settings = delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');

    expect(warnSpy).not.toHaveBeenCalled();
    expect(loadRepoConfigForNode(node())).toBeNull();
    // Claim outcome is unaffected — settings resolve from provider/policy defaults.
    expect(settings).toBeDefined();
  });

  it('absent mesh.json repeated across many claim cycles: still never warns', () => {
    for (let i = 0; i < 5; i++) {
      delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('invalid mesh.json (malformed JSON): exactly one WARN across repeated claims, and the claim still proceeds with defaults', () => {
    writeRawMeshJson(workspace, '{ this is not valid json');

    // Simulate repeated claim cycles against the same broken file.
    let settings;
    for (let i = 0; i < 4; i++) {
      settings = delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][1])).toMatch(/repo mesh\.json unreadable/);
    // Falls back to provider defaults exactly as before — behavior unchanged.
    expect(settings).toBeDefined();
    expect(loadRepoConfigForNode(node())).toBeNull();
  });

  it('invalid mesh.json (schema violation, e.g. bad version): exactly one WARN across repeated claims', () => {
    writeRawMeshJson(workspace, JSON.stringify({ version: 2 }));

    for (let i = 0; i < 3; i++) {
      delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('a later successful read resets the streak: fix the file, warn again only on a fresh break', () => {
    writeRawMeshJson(workspace, '{ broken');
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Operator fixes the file — next read succeeds and clears the streak.
    writeValidMeshJson(workspace);
    const resolved = delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    expect(warnSpy).toHaveBeenCalledTimes(1); // no new WARN on the successful read itself
    expect(loadRepoConfigForNode(node())?.providerDefaults?.autoApproveModes?.['claude-cli']).toBe('auto');
    expect(resolved).toBeDefined();

    // Break it again — a FRESH streak should warn again (not silently suppressed
    // forever by the earlier streak).
    writeRawMeshJson(workspace, '{ broken again');
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('file removed after being invalid (back to absent) also resets the streak without warning', () => {
    writeRawMeshJson(workspace, '{ broken');
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    rmSync(join(workspace, '.adhdev', 'mesh.json'));
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    // Going back to "absent" does not itself warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    writeRawMeshJson(workspace, '{ broken once more');
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  // BREAK-ONCE: reverting the fix (making the WARN fire unconditionally on every
  // loadRepoConfigForNode() miss, as before) turns this red — it asserts the
  // absent case never warns, which is exactly the behavior the fix introduces.
  it('BREAK-ONCE anchor: absent case must never warn, even once', () => {
    delegatedWorkerAutoApproveSettingsForNode({ policy: {} }, node(), CLAUDE_CLI_PROVIDER, 'claude-cli');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
