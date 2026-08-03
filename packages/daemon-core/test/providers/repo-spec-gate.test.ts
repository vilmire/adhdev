import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { ProviderLoader } from '../../src/providers/provider-loader.js';

/**
 * Gate-integrity test: prove the verification path actually loads THIS repo's
 * provider specs.
 *
 * Background — the hole this closes. `ProviderLoader` resolves the provider
 * channel from config/env, defaulting to 'stable' (the production default).
 * Neither Refinery's `test:daemon-core:fast:ci` nor `.github/workflows/ci.yml`
 * set ADHDEV_PROVIDER_CHANNEL, so every verification process ran as stable — and
 * a stable runtime REFUSES to adopt a sibling `adhdev-providers` checkout,
 * falling back to `${getConfigDir()}/providers` (an installed published bundle,
 * or under test isolation an empty temp dir). Net effect: you could edit
 * `adhdev-providers/cli/claude-cli/specs/4.0.json`, watch the gate go green, and
 * have proven nothing — the gate never read your edit. A spec regression was
 * equally invisible.
 *
 * The fix is `ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE=1`, set for the test
 * process in `test/helpers/setup-env.ts`. It lifts ONLY the sibling refusal and
 * leaves the rest of stable-channel behavior (verified-store activation, channel
 * sync, registry echo contract, unverified-tarball gate) exactly as production
 * runs it.
 *
 * These assertions are the tripwire. They fail if:
 *   - the setup env var is dropped or renamed,
 *   - the loader stops honoring it,
 *   - the loader silently reverts to a published bundle,
 *   - or the repo spec and the loaded spec ever diverge.
 *
 * If this file starts failing after an unrelated loader change, the correct
 * response is to restore repo-spec loading — NOT to relax the assertion.
 */

/** Repo root of this checkout: <root>/oss/packages/daemon-core/test/providers → <root> */
const REPO_ROOT = resolvePath(__dirname, '..', '..', '..', '..', '..');
const REPO_PROVIDERS_DIR = join(REPO_ROOT, 'adhdev-providers');

/**
 * The providers checkout is a git submodule. On a checkout where it was never
 * initialized there is nothing to compare against, so skip rather than fail —
 * an uninitialized submodule is an environment state, not a spec regression.
 * Whenever it IS present (Refinery, CI, and every normal dev checkout) the
 * assertions below run and are load-bearing.
 */
const providersCheckedOut = existsSync(join(REPO_PROVIDERS_DIR, 'cli'));

describe.skipIf(!providersCheckedOut)('provider spec gate — repo specs are what gets verified', () => {
  function freshLoader() {
    // No `channel` option and no userDir: exercise exactly what a verification
    // process gets by default. Channel resolves to 'stable' here, same as
    // production — the point is that stable + the override still reaches the
    // repo checkout.
    const loader = new ProviderLoader({ disableUpstream: true });
    loader.loadAll();
    return loader;
  }

  it('resolves the provider root to this repo\'s adhdev-providers checkout, not an installed bundle', () => {
    const loader = freshLoader();

    expect(loader.channel).toBe('stable');
    expect(loader.getUserDir()).toBe(REPO_PROVIDERS_DIR);
    expect(loader.getSourceConfig().userDirSource).toBe('sibling-marker');
  });

  it('loads claude-cli from the repo checkout', () => {
    const loader = freshLoader();

    const providerDir = loader.findProviderDir('claude-cli');
    expect(providerDir).toBe(join(REPO_PROVIDERS_DIR, 'cli', 'claude-cli'));
  });

  /**
   * The core injection assertion: read the spec THROUGH the loader's own
   * resolution path (compatibility[] → specs/*.json), then byte-compare the
   * parsed result against the repo file on disk.
   *
   * A loader reading a stale published bundle produces a different object here
   * and this fails. This is what makes "I edited the spec and the gate went
   * green" a meaningful statement.
   */
  it('the spec the loader resolves is byte-identical to the repo spec file', () => {
    const loader = freshLoader();

    const resolved = loader.resolve('claude-cli', { version: '2.1.0' });
    expect(resolved).toBeDefined();

    const resolvedSpecPath = (resolved as any)._resolvedSpecPath as string | undefined;
    expect(resolvedSpecPath, 'loader did not resolve any spec file for claude-cli').toBeDefined();

    // The resolved spec must live inside the repo checkout — not ~/.adhdev.
    expect(resolvedSpecPath!.startsWith(REPO_PROVIDERS_DIR)).toBe(true);

    const repoSpecPath = join(REPO_PROVIDERS_DIR, 'cli', 'claude-cli', 'specs', '4.0.json');
    expect(resolvedSpecPath).toBe(repoSpecPath);

    const loadedSpec = JSON.parse(readFileSync(resolvedSpecPath!, 'utf-8'));
    const repoSpec = JSON.parse(readFileSync(repoSpecPath, 'utf-8'));
    expect(loadedSpec).toEqual(repoSpec);

    // Sanity: this is a real, non-empty spec, so the equality above is not
    // two empty objects agreeing with each other.
    expect(loadedSpec.id).toBe('claude-cli');
    expect(Object.keys(loadedSpec).length).toBeGreaterThan(3);
  });

  /**
   * Guards the production safety property in the same breath: the override is
   * what unlocks repo loading, and without it a stable runtime still refuses.
   * If someone "fixes" the gate by weakening the stable refusal itself, this
   * fails.
   */
  it('without the explicit override, a stable runtime still refuses the repo checkout', () => {
    const before = process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE;
    delete process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE;
    try {
      const loader = new ProviderLoader({ disableUpstream: true });

      expect(loader.channel).toBe('stable');
      expect(loader.getUserDir()).not.toBe(REPO_PROVIDERS_DIR);
      expect(loader.getSourceConfig().userDirSource).toBe('home-default');
    } finally {
      if (before === undefined) delete process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE;
      else process.env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE = before;
    }
  });
});
