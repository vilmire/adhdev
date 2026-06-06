/**
 * Provider fixture regression tests.
 *
 * Loads the real claude-cli and codex-cli v1 manifests, builds handler
 * functions from their declarative tui blocks, and runs replayFixture()
 * against synthetic-but-realistic .pty + .expected.json fixture files.
 *
 * If a .pty file is missing or zero-length the test is skipped gracefully
 * (use it.skipIf). This makes the suite safe to run in OSS CI where the
 * adhdev-providers submodule may be absent.
 *
 * Adding a new fixture: drop <scenario>.pty + <scenario>.expected.json into
 *   adhdev-providers/cli/<provider>/fixtures/replay/
 * and add a case to the appropriate describe block below.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  replayFixture,
  formatReplayReport,
  type CliProviderHandlers,
} from '../../../src/providers/sdk/v1/fixture-tooling/index.js';
import {
  buildDetectStatusFromTui,
  type DetectStatusTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/detect-status.js';
import {
  buildParseApprovalFromTui,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import {
  buildParseApprovalFromSquash,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval-squash.js';

// ─── Path helpers ─────────────────────────────────────────────────────────

const PROVIDERS_ROOT = resolve(
  __dirname,
  '../../../../../../adhdev-providers',
);

function manifestPath(category: string, providerType: string): string {
  return resolve(PROVIDERS_ROOT, category, providerType, 'provider.v1.json');
}

function fixturePath(category: string, providerType: string, scenario: string): string {
  return resolve(
    PROVIDERS_ROOT,
    category,
    providerType,
    'fixtures',
    'replay',
    `${scenario}.expected.json`,
  );
}

function ptyExists(expectedJsonPath: string): boolean {
  if (!existsSync(expectedJsonPath)) return false;
  try {
    const spec = JSON.parse(readFileSync(expectedJsonPath, 'utf-8')) as { ptyFile?: string };
    if (!spec.ptyFile) return false;
    const dir = resolve(expectedJsonPath, '..', spec.ptyFile);
    // resolve the pty file relative to the expected.json's directory
    const ptyFull = resolve(expectedJsonPath.replace(/[^/\\]+$/, ''), spec.ptyFile);
    if (!existsSync(ptyFull)) return false;
    return statSync(ptyFull).size > 0;
  } catch {
    return false;
  }
}

function getTui(manifest: Record<string, any>): Record<string, any> {
  return manifest.tui ?? manifest.primitives?.tui;
}

// ─── Handler builders ──────────────────────────────────────────────────────

function buildHandlersFromManifest(manifest: Record<string, unknown>): CliProviderHandlers {
  const tui = getTui(manifest as Record<string, any>);
  if (!tui) {
    throw new Error('Provider manifest does not declare tui primitives');
  }
  const detect = buildDetectStatusFromTui({
    spinner: tui.spinner as DetectStatusTuiSpec['spinner'],
    settledPrompt: tui.settledPrompt as DetectStatusTuiSpec['settledPrompt'],
    modal: tui.modal as DetectStatusTuiSpec['modal'],
    dispatchOrder: tui.dispatchOrder as DetectStatusTuiSpec['dispatchOrder'],
  });

  // Build the approval parser: try the regular modal parser first; for
  // providers that also declare approvalSquash, compose both and return
  // whichever finds a match.
  const parseModal = buildParseApprovalFromTui(tui.modal as Parameters<typeof buildParseApprovalFromTui>[0]);
  const parseSquash = tui.approvalSquash
    ? buildParseApprovalFromSquash(tui.approvalSquash as Parameters<typeof buildParseApprovalFromSquash>[0])
    : null;

  return {
    detectStatus: (input) => detect(input),
    parseApproval: (input) => parseModal(input) ?? (parseSquash ? parseSquash(input) : null),
    parseSession: (_state, _input) => ({
      status: 'idle',
      modal: null,
      messages: [],
    }),
  };
}

// ─── claude-cli fixtures ───────────────────────────────────────────────────

describe('provider fixtures — claude-cli', () => {
  const MANIFEST_PATH = manifestPath('cli', 'claude-cli');

  if (!existsSync(MANIFEST_PATH)) {
    it.skip('manifest not found — skipping all claude-cli fixture tests', () => undefined);
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, unknown>;
  const handlers = buildHandlersFromManifest(manifest);

  // ─── generating-to-idle ─────────────────────────────────────────────────

  const generatingToIdlePath = fixturePath('cli', 'claude-cli', 'generating-to-idle');

  it.skipIf(!ptyExists(generatingToIdlePath))(
    'generating-to-idle: braille spinner → generating; settled prompt → idle',
    () => {
      const result = replayFixture(generatingToIdlePath, handlers, { spawnAt: 1000 });
      if (!result.overallPasses) {
        throw new Error(
          `Fixture replay failed:\n${formatReplayReport(result)}`,
        );
      }
      expect(result.overallPasses).toBe(true);
      expect(result.perAnchor).toHaveLength(2);
      expect(result.perAnchor[0].anchor.name).toBe('tool active');
      expect(result.perAnchor[1].anchor.name).toBe('settled prompt');
    },
  );

  // ─── approval-modal ─────────────────────────────────────────────────────

  const approvalModalPath = fixturePath('cli', 'claude-cli', 'approval-modal');

  it.skipIf(!ptyExists(approvalModalPath))(
    'approval-modal: modal visible → waiting_approval (modal dispatch order wins over spinner)',
    () => {
      const result = replayFixture(approvalModalPath, handlers, { spawnAt: 1000 });
      if (!result.overallPasses) {
        throw new Error(
          `Fixture replay failed:\n${formatReplayReport(result)}`,
        );
      }
      expect(result.overallPasses).toBe(true);
      expect(result.perAnchor).toHaveLength(1);
      expect(result.perAnchor[0].anchor.name).toBe('modal visible');
      // Verify the actual detectStatus from the replay.
      const actual = result.perAnchor[0].actual;
      expect(actual.detectStatus).toBe('waiting_approval');
    },
  );
});

// ─── codex-cli fixtures ────────────────────────────────────────────────────

describe('provider fixtures — codex-cli', () => {
  const MANIFEST_PATH = manifestPath('cli', 'codex-cli');

  if (!existsSync(MANIFEST_PATH)) {
    it.skip('manifest not found — skipping all codex-cli fixture tests', () => undefined);
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, unknown>;
  const handlers = buildHandlersFromManifest(manifest);

  // ─── squash-approval ────────────────────────────────────────────────────

  const squashApprovalPath = fixturePath('cli', 'codex-cli', 'squash-approval');

  it.skipIf(!ptyExists(squashApprovalPath))(
    'squash-approval: compacted trust-folder modal recovered by squash builder',
    () => {
      const result = replayFixture(squashApprovalPath, handlers, { spawnAt: 1000 });
      if (!result.overallPasses) {
        throw new Error(
          `Fixture replay failed:\n${formatReplayReport(result)}`,
        );
      }
      expect(result.overallPasses).toBe(true);
      expect(result.perAnchor).toHaveLength(2);
      expect(result.perAnchor[0].anchor.name).toBe('squashed trust-folder modal');
      expect(result.perAnchor[1].anchor.name).toBe('settled after squash');
      // Verify squash recovery shape at the first anchor.
      const squashActual = result.perAnchor[0].actual;
      expect(squashActual.parseApproval?.message).toBe('Do you trust the contents of this directory?');
      expect(squashActual.parseApproval?.buttons).toEqual(['Yes, continue', 'No, quit']);
    },
  );

  // ─── background-tool ────────────────────────────────────────────────────

  const backgroundToolPath = fixturePath('cli', 'codex-cli', 'background-tool');

  it.skipIf(!ptyExists(backgroundToolPath))(
    'background-tool: Working spinner + background terminal line → generating; cleared → idle',
    () => {
      const result = replayFixture(backgroundToolPath, handlers, { spawnAt: 1000 });
      if (!result.overallPasses) {
        throw new Error(
          `Fixture replay failed:\n${formatReplayReport(result)}`,
        );
      }
      expect(result.overallPasses).toBe(true);
      expect(result.perAnchor).toHaveLength(3);
      expect(result.perAnchor[0].anchor.name).toBe('working spinner active');
      expect(result.perAnchor[1].anchor.name).toBe('background terminal line visible');
      expect(result.perAnchor[2].anchor.name).toBe('settled after background tool');
    },
  );
});
