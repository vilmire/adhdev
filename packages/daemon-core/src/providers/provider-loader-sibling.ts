/**
 * Sibling `adhdev-providers` checkout detection for ProviderLoader: which
 * directory is the default user provider root (a development sibling
 * checkout, opted in by marker file or env var, or `<configDir>/providers`).
 *
 * Split out of provider-loader.ts (file-size gate).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../config/config.js';
import type { ProviderChannel } from './channel/contract.js';

export interface SiblingProbeContext {
  /** Directories to walk up from looking for a sibling checkout. */
  probeStarts: string[];
  /** Resolved provider channel — a stable runtime refuses sibling adoption. */
  channel: ProviderChannel;
  log(msg: string): void;
  /** Per-loader dedup of the adoption info line. */
  state: { siblingLogged: boolean };
}

const REPO_PROVIDER_DIRNAME = 'adhdev-providers';
const SIBLING_MARKER_FILE = '.adhdev-provider-root';
const SIBLING_ENV_VAR = 'ADHDEV_USE_SIBLING_PROVIDERS';
/**
 * Verification-path opt-in that lets a STABLE runtime adopt a sibling
 * `adhdev-providers` checkout, without switching the provider channel.
 *
 * Why this exists as its own switch rather than reusing
 * `ADHDEV_PROVIDER_CHANNEL=preview`: the channel is not a single-purpose
 * flag. It also selects which verified-store activations are loaded
 * (`listActiveActivations(channel)`), which rows the channel sync targets,
 * whether the registry echo contract is enforced (`channel === 'preview'`
 * in channel/runtime.ts), and whether the unverified tarball fallback is
 * permitted. Flipping the channel to make the repo's specs load would drag
 * all of that along and would no longer be testing the stable code path.
 * This switch changes exactly one thing: the sibling-adoption refusal.
 *
 * Production safety is unchanged. A stable daemon still refuses a sibling
 * checkout, because the refusal is only lifted when this env var is
 * explicitly set to '1' AND the pre-existing opt-in (marker file or
 * ADHDEV_USE_SIBLING_PROVIDERS) already applies. Nothing sets it outside
 * the test/verification harness.
 */
const SIBLING_STABLE_OVERRIDE_ENV_VAR = 'ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE';

/** Process-level dedup for stderr sibling-adoption notices (shared across all ProviderLoader instances). */
const siblingStderrLogged = new Set<string>();

/**
 * Process-level dedup for the stable-channel sibling REFUSAL notice, mirroring
 * `siblingStderrLogged` on the adoption path. This was previously an instance
 * field, so every new ProviderLoader re-armed it. Under vitest's per-file module
 * isolation that meant one line per test file (measured 36–40 repeats), which
 * flooded the truncated tail of Refinery failure reports and cut off the actual
 * failing test names and assertions — diagnostic output destroying diagnostics.
 */
const siblingRefusalLogged = new Set<string>();

function looksLikeProviderRoot(candidate: string): boolean {
  try {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false;
    return ['ide', 'extension', 'cli'].some((category) =>
      fs.existsSync(path.join(candidate, category))
    );
  } catch {
    return false;
  }
}

function hasProviderRootMarker(candidate: string): boolean {
  try {
    return fs.existsSync(path.join(candidate, SIBLING_MARKER_FILE));
  } catch {
    return false;
  }
}

export function detectDefaultUserDir(ctx: SiblingProbeContext): { path: string; source: 'sibling-env' | 'sibling-marker' | 'home-default' } {
  const fallback = path.join(getConfigDir(), 'providers');
  const envOptIn = process.env[SIBLING_ENV_VAR] === '1';
  const visited = new Set<string>();

  for (const start of ctx.probeStarts) {
    let current = path.resolve(start);
    while (!visited.has(current)) {
      visited.add(current);
      const siblingCandidate = path.join(path.dirname(current), REPO_PROVIDER_DIRNAME);
      if (looksLikeProviderRoot(siblingCandidate)) {
        const hasMarker = hasProviderRootMarker(siblingCandidate);
        if (envOptIn || hasMarker) {
          // Stage 2 channel policy: a stable (production) runtime NEVER
          // adopts a sibling checkout — `.adhdev-provider-root` must not
          // silently override verified channel activations. Non-stable
          // development use still requires the explicit opt-in (marker
          // file or env var).
          //
          // Verification-path exception: the test/CI/Refinery harness must
          // exercise the repo's own provider specs, not whichever published
          // bundle happens to be installed on the runner. Without this,
          // editing e.g. adhdev-providers/cli/claude-cli/specs/4.0.json and
          // watching the gate go green proves nothing — the gate never
          // loaded the edit. The override is deliberately narrower than a
          // channel flip: it lifts ONLY this refusal, leaving verified-store
          // activation, channel sync, the registry echo contract and the
          // unverified-tarball gate on their stable behavior. Production is
          // unaffected because nothing sets this env var outside the harness.
          const stableSiblingOverride =
            process.env[SIBLING_STABLE_OVERRIDE_ENV_VAR] === '1';
          if (ctx.channel === 'stable' && !stableSiblingOverride) {
            if (!siblingRefusalLogged.has(siblingCandidate)) {
              siblingRefusalLogged.add(siblingCandidate);
              ctx.log(`Refusing sibling provider checkout (channel=stable): ${siblingCandidate}. Set providerChannel=preview (or ${'ADHDEV_PROVIDER_CHANNEL'}=preview) to opt in for development.`);
              try {
                process.stderr.write(
                  `[adhdev] Ignoring sibling adhdev-providers checkout on stable channel: ${siblingCandidate}\n`,
                );
              } catch { /* ignore */ }
            }
          } else {
          const source: 'sibling-env' | 'sibling-marker' = hasMarker ? 'sibling-marker' : 'sibling-env';
          if (!ctx.state.siblingLogged) {
            ctx.log(`Using sibling provider checkout (${source}): ${siblingCandidate}`);
            ctx.state.siblingLogged = true;
          }
          // Force-surface adoption to stderr once per sibling path per process, so CLI
          // entry points that suppress logFn still leave a visible trail.
          if (!siblingStderrLogged.has(siblingCandidate)) {
            siblingStderrLogged.add(siblingCandidate);
            try {
              process.stderr.write(
                `[adhdev] Using sibling adhdev-providers checkout (${source}): ${siblingCandidate}\n`,
              );
            } catch { /* ignore */ }
          }
          return { path: siblingCandidate, source };
          }
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return { path: fallback, source: 'home-default' };
}
