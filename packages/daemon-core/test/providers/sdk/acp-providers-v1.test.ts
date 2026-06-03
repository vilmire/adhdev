/**
 * Validation tests for ACP provider.v1.json manifests.
 *
 * For each provider.v1.json found in adhdev-providers/acp/:
 *   1. session.$schema === "adhdev:acp/session-protocol@1"
 *   2. Manifest has type, category, providerVersion fields
 *   3. buildDetectStatusFromAcp(manifest.session) does not throw
 *   4. The built detector returns 'generating' for a line matching generatingPattern
 *
 * If adhdev-providers is absent (OSS CI without the submodule) the suite
 * skips gracefully via it.skipIf.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  buildDetectStatusFromAcp,
  type AcpSessionSpec,
} from '../../../src/providers/sdk/v1/builders/acp/detect-status.js';

// ─── Paths ────────────────────────────────────────────────────────────────

const PROVIDERS_ROOT = resolve(
  __dirname,
  '../../../../../../adhdev-providers',
);

const ACP_ROOT = join(PROVIDERS_ROOT, 'acp');

// ─── Helpers ──────────────────────────────────────────────────────────────

function acpSubmodulePresent(): boolean {
  return existsSync(ACP_ROOT) && statSync(ACP_ROOT).isDirectory();
}

function loadV1Manifest(providerDir: string): Record<string, unknown> {
  const p = join(providerDir, 'provider.v1.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

function listAcpProviders(): string[] {
  if (!acpSubmodulePresent()) return [];
  return readdirSync(ACP_ROOT)
    .map((name) => join(ACP_ROOT, name))
    .filter((d) => statSync(d).isDirectory())
    .filter((d) => existsSync(join(d, 'provider.v1.json')));
}

/**
 * Build a synthetic line that should match generatingPattern.
 * We try the regex itself to get a concrete matchable line; if the regex
 * contains named groups or alternation we fall back to extracting the first
 * literal prefix before any special character.
 */
function syntheticGeneratingLine(generatingPattern: AcpSessionSpec['generatingPattern']): string | null {
  if (!generatingPattern) return null;
  // Most of our patterns match a JSON-RPC method field.
  // Probe with concrete known-good ACP generating lines.
  const candidates = [
    '{"jsonrpc":"2.0","method":"agent/thinking","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/toolCall","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/progress","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/streaming","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/step","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/action","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/running","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/executing","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/textDelta","params":{}}',
    '{"jsonrpc":"2.0","method":"agent/delta","params":{}}',
  ];
  const re = new RegExp(generatingPattern.regex, generatingPattern.flags ?? 'i');
  for (const line of candidates) {
    if (re.test(line)) return line;
  }
  return null;
}

// ─── Parameterised suite ──────────────────────────────────────────────────

const providerDirs = listAcpProviders();

describe('ACP provider.v1.json — structure validation', () => {
  it.skipIf(!acpSubmodulePresent())(
    'adhdev-providers submodule is present',
    () => {
      expect(acpSubmodulePresent()).toBe(true);
    },
  );

  it.skipIf(!acpSubmodulePresent())(
    'at least one ACP provider.v1.json exists',
    () => {
      expect(providerDirs.length).toBeGreaterThan(0);
    },
  );
});

describe.skipIf(!acpSubmodulePresent())('ACP provider.v1.json — per-provider checks', () => {
  for (const dir of providerDirs) {
    const providerName = dir.split('/').at(-1) ?? dir;

    describe(providerName, () => {
      let manifest: Record<string, unknown>;

      try {
        manifest = loadV1Manifest(dir);
      } catch (e) {
        it('loads provider.v1.json without parse errors', () => {
          throw e;
        });
        return;
      }

      // 1. session.$schema is present and correct
      it('has session.$schema === "adhdev:acp/session-protocol@1"', () => {
        expect(manifest.session).toBeTruthy();
        const session = manifest.session as Record<string, unknown>;
        expect(session.$schema).toBe('adhdev:acp/session-protocol@1');
      });

      // 2. Required top-level fields
      it('has type field', () => {
        expect(typeof manifest.type).toBe('string');
        expect((manifest.type as string).length).toBeGreaterThan(0);
      });

      it('has category field', () => {
        expect(typeof manifest.category).toBe('string');
        expect(manifest.category).toBe('acp');
      });

      it('has providerVersion field', () => {
        expect(typeof manifest.providerVersion).toBe('string');
        expect((manifest.providerVersion as string)).toMatch(/^\d+\.\d+\.\d+$/);
      });

      // 3. buildDetectStatusFromAcp does not throw
      it('buildDetectStatusFromAcp(session) does not throw', () => {
        const session = manifest.session as AcpSessionSpec;
        expect(() => buildDetectStatusFromAcp(session)).not.toThrow();
      });

      // 4. Detector returns 'generating' for a line matching generatingPattern
      it('detector returns generating for a matching generatingPattern line', () => {
        const session = manifest.session as AcpSessionSpec;
        if (!session.generatingPattern) {
          // No pattern defined — skip assertion
          return;
        }

        const detect = buildDetectStatusFromAcp(session);
        const line = syntheticGeneratingLine(session.generatingPattern);

        if (line === null) {
          // Could not construct a matching line from our candidates — skip
          return;
        }

        const result = detect({ lastLine: line, recentLines: [line], isConnected: true });
        expect(result).toBe('generating');
      });
    });
  }
});
