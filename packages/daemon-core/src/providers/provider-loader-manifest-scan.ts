/**
 * Manifest discovery for ProviderLoader (pure move, 2026-09-18).
 *
 * `loadProviderDir` is the recursive provider.json / provider.v1.json scanner
 * that was `ProviderLoader.loadDir`; `findProviderDirInternal` is the
 * on-disk lookup that was the same-named private method. Both bodies are
 * byte-identical to the originals — the only change is that the four/three
 * pieces of instance state each read (`log`, `userDir`, `providers`,
 * `channel` / the two path helpers) now arrive through an explicit context
 * object instead of `this`. The `providers` Map is passed by reference, so
 * the mutation semantics the scanner relies on are unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from '../config/config.js';
import { validateProviderDefinition } from './provider-schema.js';
import { registerProviderScriptRootSafely } from './provider-loader-support.js';
import type { ProviderCategory, ProviderModule, ProviderScripts } from './contracts.js';
import type { ProviderChannel } from './channel/contract.js';

/** Instance state `loadProviderDir` reads/mutates, passed explicitly. */
export interface ManifestScanContext {
  log: (msg: string) => void;
  /** User-override provider root, used for trust-layer classification. */
  userDir: string;
  /** Live provider map — mutated in place, exactly as the inlined code did. */
  providers: Map<string, ProviderModule>;
  channel: ProviderChannel;
}

/** Instance state `findProviderDirInternal` reads. */
export interface ProviderDirContext {
  providers: Map<string, ProviderModule>;
  getProviderRoots: () => string[];
  getProviderDir: (root: string, category: ProviderCategory, type: string) => string;
}

/**
 * Find the on-disk directory for a provider by type.
 * Canonical shape: root/category/type.
 */
export function findProviderDirInternal(ctx: ProviderDirContext, type: string): string | null {
  const provider = ctx.providers.get(type);
  if (!provider) return null;
  const cat = provider.category;

  const searchRoots = ctx.getProviderRoots();
  const hasManifest = (dir: string) =>
    fs.existsSync(path.join(dir, 'provider.v1.json')) || fs.existsSync(path.join(dir, 'provider.json'));
  const readManifestType = (dir: string): string | null => {
    for (const file of ['provider.v1.json', 'provider.json']) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (typeof data?.type === 'string') return data.type;
      } catch { /* skip */ }
    }
    return null;
  };
  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    const candidate = ctx.getProviderDir(root, cat, type);
    if (hasManifest(candidate)) return candidate;
    // Scan category dir for type match
    const catDir = path.join(root, cat);
    if (fs.existsSync(catDir)) {
      try {
        for (const entry of fs.readdirSync(catDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const entryDir = path.join(catDir, entry.name);
          const manifestType = readManifestType(entryDir);
          if (manifestType === type) return entryDir;
        }
      } catch { /* skip */ }
    }
  }
  return null;
}

/**
* Recursively scan directory to load provider files
* Supports two formats:
*   1. provider.json (metadata) + scripts.js (optional CDP scripts)
*   2. provider.js (legacy — everything in one file)
* Structure: dir/category/agent-name/provider.{json,js}
*/
export function loadProviderDir(ctx: ManifestScanContext, dir: string, excludeDirs?: string[]): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;

  const scan = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    // v1-first manifest selection. provider.v1.json (the SDK-shape
    // manifest with `overrides`, `tui`, `source`, `canonicalHistory`)
    // wins over provider.json (legacy). Without this branch the v1
    // file is silently ignored — that's how the codex-cli `overrides`
    // path and the tui-block builders went un-honored for the first
    // pass of SDK rollout.
    const hasV1 = entries.some(e => e.name === 'provider.v1.json');
    const hasJson = entries.some(e => e.name === 'provider.json');

    if (hasV1 || hasJson) {
      const manifestFile = hasV1 ? 'provider.v1.json' : 'provider.json';
      const jsonPath = path.join(d, manifestFile);
      try {
        const raw = fs.readFileSync(jsonPath, 'utf-8');
        const mod = JSON.parse(raw) as Omit<ProviderModule, 'extensionIdPattern'> & {
          extensionIdPattern?: RegExp | string;
        };

        // Validate v1 manifests against the SDK schema. Failures are
        // surfaced as a single warning line with all issues attached
        // so manifest authors don't need to guess which field is wrong.
        // Loading still proceeds — bricking the daemon on a single
        // bad field would be worse than running with a known warning.
        if (hasV1 && (mod?.category === 'cli' || mod?.category === 'acp')) {
          try {
            const { validateCliProviderManifest, validateAcpProviderManifest, formatManifestValidationIssues } =
              require('./sdk/v1/validators/manifest.js') as typeof import('./sdk/v1/validators/manifest.js');
            const validation = mod.category === 'acp'
              ? validateAcpProviderManifest(mod)
              : validateCliProviderManifest(mod);
            if (!validation.ok) {
              ctx.log(`⚠ ${jsonPath}: schema validation failed:\n${formatManifestValidationIssues(validation.issues)}`);
            }
          } catch (e: any) {
            // Validator load failed — log once and continue so a
            // broken validator can't take down provider loading.
            ctx.log(`⚠ ${jsonPath}: validator unavailable: ${e?.message || e}`);
          }
        }

        // Restore RegExp fields from JSON (extensionIdPattern)
        if (typeof mod.extensionIdPattern === 'string') {
          const flags = mod.extensionIdPattern_flags || '';
          mod.extensionIdPattern = new RegExp(mod.extensionIdPattern, flags);
        }
        const { extensionIdPattern_flags, extensionIdPattern, ...providerFields } = mod;
        const normalizedProvider: ProviderModule = {
          ...providerFields,
          ...(extensionIdPattern instanceof RegExp ? { extensionIdPattern } : {}),
        };

        // v1 manifests use `nativeHistory` as the canonical field name.
        // Legacy v0 manifests use `canonicalHistory`. The daemon's
        // runtime + downstream code reads `provider.nativeHistory`, so
        // for legacy manifests we copy `canonicalHistory` into
        // `nativeHistory` here. We also keep `canonicalHistory`
        // populated in both directions (deprecated alias) so any
        // external consumers still reading the old name keep working
        // during the one-release deprecation window.
        const nh = (normalizedProvider as any).nativeHistory;
        const ch = (normalizedProvider as any).canonicalHistory;
        if (nh && !ch) {
          (normalizedProvider as any).canonicalHistory = nh;
        } else if (ch && !nh) {
          (normalizedProvider as any).nativeHistory = ch;
        }

        const validation = validateProviderDefinition(normalizedProvider);
        for (const warning of validation.warnings) {
          ctx.log(`⚠ ${jsonPath}: ${warning}`);
        }
        if (validation.errors.length > 0) {
          ctx.log(`⚠ Invalid provider at ${jsonPath}: ${validation.errors.join('; ')}`);
        } else {
          // Load scripts.js if exists (IDE/Extension)
          // Skip for compatibility-format providers — scripts loaded lazily in resolve()
          const hasCompatibility = Array.isArray(normalizedProvider.compatibility);
          const scriptsPath = path.join(d, 'scripts.js');
          if (!hasCompatibility && fs.existsSync(scriptsPath)) {
            try {
              // Gate the IDE/extension scripts.js (legacy single-file
              // format) under the same whitelist. `d` here is the
              // provider dir; its grandparent contains _shared.
              registerProviderScriptRootSafely(path.dirname(path.dirname(d)));
              delete require.cache[require.resolve(scriptsPath)];
              const scripts = require(scriptsPath) as Partial<ProviderScripts>;
              normalizedProvider.scripts = scripts;
            } catch (e) {
              ctx.log(`⚠ Failed to load scripts: ${scriptsPath}: ${(e as Error).message}`);
            }
          }

          // Classify trust based on which on-disk layer this manifest
          // came from + whether it ships JavaScript hooks. The dashboard
          // uses this to render trust badges; non-spec external manifests
          // need an explicit user confirm before activation.
          const externalDirAbs = path.join(getConfigDir(), 'external');
          // The verified channel store (<configDir>/providers/.store/…)
          // lives under the default user dir but is verified upstream
          // content, not a user override — exclude it explicitly.
          const isChannelStoreObject = d.includes(`${path.sep}.store${path.sep}`);
          const layer: 'user' | 'upstream' | 'external' = d.startsWith(externalDirAbs)
            ? 'external'
            : (d.startsWith(ctx.userDir) && !d.includes('.upstream') && !isChannelStoreObject ? 'user' : 'upstream');
          try {
            const { inspectManifestShape, classifyTrust } =
              require('./provider-trust.js') as typeof import('./provider-trust.js');
            const shape = inspectManifestShape(mod as Record<string, unknown>);
            const trust = classifyTrust(layer, shape);
            (normalizedProvider as any)._sourceLayer = layer;
            (normalizedProvider as any)._sourceTrust = trust;
            (normalizedProvider as any)._manifestShape = shape;
            // For external-namespaced layouts (external/<source>/…) record
            // which source the manifest came from so dashboards can name
            // it in the trust badge.
            if (layer === 'external') {
              const rel = path.relative(externalDirAbs, d);
              const firstSeg = rel.split(path.sep)[0];
              if (firstSeg && firstSeg !== '..') (normalizedProvider as any)._sourceName = firstSeg;
            }
          } catch { /* best-effort — trust is enrichment, not gating */ }

          const existed = ctx.providers.has(normalizedProvider.type);
          ctx.providers.set(normalizedProvider.type, normalizedProvider);
          count++;
          const source = (normalizedProvider as any)._sourceLayer ?? 'upstream';
          const overrideWarning = existed && source === 'user' ? ' ⚠ OVERRIDES upstream' : '';
          const sourceName = (normalizedProvider as any)._sourceName;
          // Say WHERE the manifest was actually read from, not just which
          // precedence slot it occupies. A content-addressed store object
          // takes the `upstream` TRUST layer (deliberately — see the layer
          // derivation above, which must not change), but logging it as
          // `[upstream]` reads as "~/.adhdev/providers/.upstream", and the
          // store load runs AFTER and overwrites that directory's entries.
          // Two separate misdiagnoses came from trusting that label while
          // the daemon was really running a pinned store object of a
          // different version, so name the store and pin the version.
          const pinnedVersion = (normalizedProvider as any).providerVersion;
          const sourceLabel = isChannelStoreObject
            ? `channel-store:${ctx.channel}${pinnedVersion ? ` v${pinnedVersion}` : ''}`
            : (sourceName ? `${source}/${sourceName}` : source);
          ctx.log(`  ${existed ? '🔄' : '✅'} ${normalizedProvider.type} (${normalizedProvider.category}) — ${normalizedProvider.name} [${sourceLabel}]${overrideWarning}`);
        }
      } catch (e) {
        ctx.log(`⚠ Failed to load ${jsonPath}: ${(e as Error).message}`);
      }
    }

    // Continue scanning subdirectories (only for dirs without provider.json)
    if (!hasJson) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        // `examples/` is a documentation / scaffold tree (e.g. stub-cli),
        // not a real provider source. SDK authors copy from here when
        // writing a new provider; daemon-core tests reference the
        // manifest by path. Keep it off the dashboard's provider list.
        if (d === dir && entry.name === 'examples') continue;
        if (excludeDirs && d === dir && excludeDirs.includes(entry.name)) continue;
        scan(path.join(d, entry.name));
      }
    }
  };

  scan(dir);
  return count;
}
