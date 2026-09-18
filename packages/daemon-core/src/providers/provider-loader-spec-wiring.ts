/**
 * Late-binding spec.json / native-history wiring for ProviderLoader.resolve().
 *
 * Extracted verbatim from provider-loader.ts (pure move, 2026-09-18). This is
 * the tail of resolve(): after every script-loading path has run, the resolved
 * provider gets its spec control_bar stubs and its native-history reader /
 * lister wired. It touches only its arguments — no ProviderLoader instance
 * state — which is why it moves cleanly.
 */

import { executeNativeHistory, executeNativeHistoryList } from './spec/native-history-executor.js';
import { trimInProgressTurnToolTail } from './chat-message-normalization.js';
import {
  createNativeHistoryDispatcher,
  createNativeHistoryListDispatcher,
  type ReaderId,
} from './native-history/dispatcher.js';
import type { ProviderModule, ResolvedProvider } from './contracts.js';
import {
  matchesVersion,
  synthesizeControlsFromControlBar,
  registerProviderScriptRootSafely,
} from './provider-loader-support.js';

/**
 * Apply the spec-file + native-history wiring to an already script-resolved
 * provider. Mutates `resolved` in place (as the inlined code did).
 */
export function applySpecNativeHistoryWiring(
  resolved: ResolvedProvider,
  base: ProviderModule,
  providerDir: string | undefined,
  currentVersion: string | undefined,
): void {
  // (spec migration) Late-binding spec.json native-history hook. Runs
  // *after* every script-loading path (compatibility / defaultScriptDir /
  // overrides) so it deterministically wins over a legacy v1 scripts.js
  // export. Three modes, picked by spec.json's native_history block:
  //   1. source     — declarative jsonl/sqlite executor (new-provider path,
  //                   no daemon change needed for new on-disk formats)
  //   2. override_path — provider-supplied reader file (escape hatch for
  //                   exotic formats); module default-exports a reader fn
  //   3. reader     — built-in reader id (claude-cli / codex-cli /
  //                   antigravity-cli / hermes-cli), kept for backwards
  //                   compatibility with the four shipped providers
  if (providerDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('node:path');
      // Pick the right spec file for the detected CLI version. Resolution
      // order:
      //   1. compatibility[i].spec where ideVersion matches currentVersion
      //      (lets a provider ship specs/2.0.json, specs/2.1.json, etc.
      //      alongside the matching scriptDir)
      //   2. specs/default.json — explicit fallback
      //   3. spec.json — legacy single-spec layout
      // Missing files fall through silently to the next candidate.
      const candidates: string[] = [];
      if (Array.isArray((base as any).compatibility)) {
        for (const entry of (base as any).compatibility) {
          if (typeof entry?.spec !== 'string') continue;
          // If currentVersion is unknown (cli-manager hasn't probed yet)
          // we still let compatibility entries that don't pin a version
          // through, plus any entry whose pin matches.
          const matches = !entry.ideVersion
            || (currentVersion && matchesVersion(currentVersion, entry.ideVersion))
            || !currentVersion;
          if (matches) candidates.push(path.join(providerDir, entry.spec));
        }
      }
      candidates.push(path.join(providerDir, 'specs', 'default.json'));
      candidates.push(path.join(providerDir, 'spec.json'));
      const specPath = candidates.find((p: string) => fs.existsSync(p));
      // native_history block, resolved from either the separate spec file
      // (snake_case `native_history`) or — for v1-manifest-only providers that
      // ship no specs/*.json — the inline camelCase `nativeHistory` on the
      // manifest itself. The separate spec file wins when both exist. Without
      // the v1-manifest fallback, a provider whose ONLY declaration is an
      // inline `nativeHistory.source` (e.g. opencode's sqlite source) never got
      // its `scripts.readNativeHistory` wired: the whole block was gated on
      // `specPath`, so read_chat returned native-unavailable, the assistant
      // reply (only in the on-disk store, never in the PTY snapshot) was
      // dropped, providerSessionId stayed null, and the session wedged in
      // `generating` because no native completion evidence ever arrived.
      let nh: any | undefined;
      if (specPath) {
        // Hand the resolved spec path off to route.ts via a hidden field
        // so the routing layer doesn't have to repeat the candidate walk.
        (resolved as any)._resolvedSpecPath = specPath;
        // Extract control_bar + native_history directly from the JSON header.
        let specControls: any[] | undefined;
        try {
          const rawSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
          specControls = rawSpec.control_bar;
          nh = rawSpec.native_history;
        } catch { /* unreadable spec — leave controls/native unavailable */ }
        // Stub each control_bar entry as a provider.scripts.<id>. The
        // upstream invoke_provider_script gate checks that the script
        // name exists on provider.scripts before calling adapter.invokeScript;
        // for spec providers the *actual* dispatch happens inside
        // SpecCliAdapter.invokeScript which maps the name to control_bar.
        // The stub is just a presence marker so the gate doesn't reject.
        if (specControls && specControls.length > 0) {
          resolved.scripts = { ...(resolved.scripts || {}) };
          for (const ctl of specControls) {
            if (!(resolved.scripts as any)[ctl.id]) {
              (resolved.scripts as any)[ctl.id] = (..._args: unknown[]) => ({
                __spec_control: true,
                controlId: ctl.id,
                actionType: ctl.action.type,
              });
            }
          }
          // Bridge the spec control_bar into the web-facing controls schema so
          // the dashboard chat bar actually renders Model/Mode pickers. Only
          // synthesize when the provider hasn't already declared its own
          // `controls` in provider.v1.json (e.g. hermes-cli) — an explicit
          // declaration wins and must not be clobbered.
          const hasDeclaredControls = Array.isArray((resolved as any).controls)
            && (resolved as any).controls.length > 0;
          if (!hasDeclaredControls) {
            const synthesized = synthesizeControlsFromControlBar(specControls);
            if (synthesized.length > 0) {
              resolved.controls = synthesized;
            }
          }
        }
      }
      // Fall back to the v1 manifest's inline `nativeHistory` (camelCase) when
      // no separate spec file provided a `native_history` block. Only treat it
      // as a declarative reader source when it actually carries source/
      // override_path/reader — a bare `nativeHistory` marker that only names
      // `scripts.readSession` (claude/codex/antigravity, whose real reader is
      // wired from their specs/*.json) must not be mistaken for one.
      if (!nh) {
        const inlineNh = (base as any)?.nativeHistory || (resolved as any)?.nativeHistory;
        if (inlineNh && (inlineNh.source || inlineNh.override_path || inlineNh.reader)) {
          nh = inlineNh;
        }
      }
      if (nh) {
        let reader: ((input: any) => any) | null = null;
        // lister enumerates all saved sessions for the store. Only the
        // declarative jsonl `source` path can enumerate by directory walk;
        // override/reader providers wire their own listSessions (or none).
        let lister: ((input: any) => any) | null = null;
        let format = 'spec';

        if (nh.source) {
          format = `spec-${nh.source.kind}`;
          reader = (input: any) => executeNativeHistory(nh, input);
          // Only jsonl stores are file-per-session and enumerable by a
          // directory walk. sqlite sources enumerate through their own
          // `session_query` (not implemented as a lister yet), so leave
          // listSessions unwired there rather than advertising an enumerator
          // that always returns empty.
          if (nh.source.kind === 'jsonl') {
            lister = (input: any) => executeNativeHistoryList(nh, input);
          }
        } else if (nh.override_path) {
          const overrideFile = path.resolve(providerDir, nh.override_path);
          if (fs.existsSync(overrideFile)) {
            try {
              registerProviderScriptRootSafely(path.dirname(path.dirname(providerDir)));
              delete require.cache[require.resolve(overrideFile)];
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const mod = require(overrideFile);
              const fn = typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
              if (fn) {
                format = 'spec-override';
                reader = (input: any) => fn(input);
              }
            } catch { /* fall through — leave native unavailable */ }
          }
        } else if (nh.reader) {
          const dispatch = createNativeHistoryDispatcher(nh.reader as ReaderId);
          format = nh.reader;
          reader = (input: any) => dispatch(input);
          // Readers whose on-disk store is enumerable expose a lister too.
          // Without it `list_saved_sessions` returns [] no matter how many
          // transcripts exist (same gap the declarative jsonl path fills
          // above). Returns null for readers that have no enumerator, so the
          // existing claude/codex/antigravity/hermes wiring is unchanged.
          const listDispatch = createNativeHistoryListDispatcher(nh.reader as ReaderId);
          if (listDispatch) lister = (input: any) => listDispatch(input);
        }

        if (reader) {
          resolved.scripts = { ...(resolved.scripts || {}) };
          // (excludeInProgressTurn restore) Apply the in-flight tool-tail trim
          // HERE — the one choke point every native-history route funnels
          // through (declarative source / override_path / built-in reader) —
          // rather than inside a single route's executor.
          //
          // The flag was honoured only by `_shared/native_history.js`'s
          // `trimIncompleteLastTurn`. When providers moved to spec-driven
          // reading, `codex-cli`'s declaration became the sole surviving record
          // of the intent while no live route consumed it, so during
          // `waiting_approval` every provider rendered the very tool call
          // awaiting approval as an already-executed `⏺ Tool` bubble.
          // Wrapping the dispatch restores it for all of them at once and
          // keeps future routes covered by construction.
          //
          // The trim is idempotent (see trimInProgressTurnToolTail), so an
          // out-of-tree script that still trims its own result is unaffected.
          (resolved.scripts as any).readNativeHistory = (input: any) => {
            const result = reader!(input);
            const wantsTrim = input?.excludeInProgressTurn === true || input?.args?.excludeInProgressTurn === true;
            if (!wantsTrim || !result || !Array.isArray(result.messages)) return result;
            const trimmed = trimInProgressTurnToolTail(result.messages);
            return trimmed === result.messages ? result : { ...result, messages: trimmed };
          };
          // Wire the enumerator alongside the reader. Without both the
          // `scripts.listSessions` marker AND the `listNativeHistory` fn,
          // `getProviderNativeHistoryScript(...,'listSessions')` resolves to
          // undefined and `list_saved_sessions` returns [] for every
          // declarative-source provider (claude/codex/antigravity/kimi/cursor)
          // regardless of how many transcripts are on disk.
          const scriptsMarker: { readSession: string; listSessions?: string } = { readSession: 'readNativeHistory' };
          if (lister) {
            (resolved.scripts as any).listNativeHistory = lister;
            scriptsMarker.listSessions = 'listNativeHistory';
          }
          // Spread the declarative block FIRST so source/override_path/
          // reader/contractVersion survive, then override only the runtime
          // fields. The previous shape dropped `source`, and
          // ProviderCliAdapter.detectBackgroundTask requires it — so a
          // loader-resolved declarative provider (production kimi) always
          // reported background detection inactive even though the detector
          // unit tests (which pass the manifest shape directly) passed
          // (rc.29 production-shape gap).
          (resolved as any).nativeHistory = {
            ...nh,
            format,
            watchPath: undefined,
            scripts: scriptsMarker,
            mode: 'native-source',
          };
        }
      }
    } catch {
      // Best-effort — spec wiring failure must not break legacy providers.
    }
  }
}
