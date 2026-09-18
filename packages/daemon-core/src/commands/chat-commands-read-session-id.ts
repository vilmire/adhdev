/**
 * chat-commands-read-session-id — read-path provider session-id resolution and
 * the durable read-pin map (mesh session id → provider-native conversation id).
 *
 * Extracted from chat-commands-read.ts as a pure move ahead of the file-size
 * gate; logic is unchanged and chat-commands-read.ts keeps its exact public
 * export surface by re-exporting the test hooks defined here.
 *
 * Holds: the in-memory + on-disk pin state, the runtime-fallback detection that
 * stops a daemon runtime session id from being mistaken for a provider-native
 * conversation uuid, the id-resolution helpers every native-history read path
 * shares, and the debug-trace wrapper keyed off the read interaction id.
 */

import type { CommandHelpers } from './handler.js';
import type { CliAdapter } from '../cli-adapter-types.js';
import type { ProviderModule } from '../providers/contracts.js';
import { clearPersistedProviderSessionPins, loadPersistedProviderSessionPins, recordPersistedProviderSessionPin } from '../config/state-store.js';
import { recordDebugTrace } from '../logging/debug-trace.js';
import { getTargetInstance } from './chat-commands-shared.js';

// Last successfully-bound provider-native session id, keyed by the mesh session
// id (targetSessionId) the read was scoped to. The live pin lives on the
// CliProviderInstance and is torn down when the turn ends; a *post-turn* read
// then finds historySessionId empty AND canBindFromLiveSession=false (no live
// spawnedAtMs), so readCliProviderNativeHistory would fail closed with
// native_history_workspace_only_lookup_unsafe and surface providerSessionId=null
// + zero rows even though the transcript is physically present in state.db.
// Persisting the last resolved id here lets that later read reuse the known pin
// and run the native query normally instead of fail-closing. Refreshed on every
// successful bind; never lets an empty id clear a known pin. Keyed by mesh
// session id so pins never alias across distinct sessions sharing a workspace.
//
// The map is ALSO mirrored to disk (state.json sessionProviderSessionPins) so a
// pin survives a daemon restart. Without that, an attach-restored antigravity
// session (spawnedAtMs=0, so no live spawn floor) that has sat idle past the
// native reader's recency window can no longer resolve its own conversation .db
// after the daemon comes back — read_chat falls to the PTY parse and the
// dashboard shows the user prompt with the assistant tail missing
// (ANTIGRAVITY-FINAL-MESSAGE-TAIL-GAP). The in-memory map stays the hot path;
// disk is the cold-start hydration source, read lazily on the first miss.
const lastBoundProviderSessionIdByMeshSession = new Map<string, string>();
let persistedProviderSessionPinsHydrated = false;

function hydratePersistedProviderSessionPinsOnce(): void {
    if (persistedProviderSessionPinsHydrated) return;
    persistedProviderSessionPinsHydrated = true;
    try {
        for (const [key, value] of Object.entries(loadPersistedProviderSessionPins())) {
            // Never let a stale persisted value clobber a fresher in-memory bind
            // recorded earlier this process lifetime.
            if (!lastBoundProviderSessionIdByMeshSession.has(key)) {
                lastBoundProviderSessionIdByMeshSession.set(key, value);
            }
        }
    } catch {
        // Best-effort: a missing/corrupt state file just means no cold-start pins.
    }
}

export function recordBoundProviderSessionId(h: CommandHelpers, meshSessionId: string | undefined, providerSessionId: string | undefined): void {
    const key = typeof meshSessionId === 'string' ? meshSessionId.trim() : '';
    const value = typeof providerSessionId === 'string' ? providerSessionId.trim() : '';
    if (!key || !value) return;
    // SSOT: the session registry entry (keyed by sessionId == instanceId) is the
    // authoritative sessionId → conversation-uuid record. Writing it here — the
    // moment a native read resolves the real conversation id — makes
    // getHistorySessionId return it directly on every subsequent read, so the
    // conversation is exact-bound instead of re-resolved by the spawn-floor/mtime
    // heuristic (the crosswire/theft source). The pin below stays as the durable
    // cross-restart mirror (the registry is in-memory and cleared on restart).
    try { h.ctx?.sessionRegistry?.setProviderSessionId?.(key, value); } catch { /* best-effort SSOT write-back */ }
    lastBoundProviderSessionIdByMeshSession.set(key, value);
    // Always attempt the disk mirror — recordPersistedProviderSessionPin is itself a
    // no-op when the ON-DISK value already matches, so it does not rewrite state.json
    // on steady re-reads, yet it still lands a pin the in-memory map already holds but
    // disk lost (a prior write clobbered by another state-store writer, or a restart
    // whose hydration ran before this bind). Gating on the in-memory previous value
    // let the in-memory and on-disk pin diverge permanently, defeating the persistence.
    try { recordPersistedProviderSessionPin(key, value); } catch { /* best-effort disk mirror */ }
}

export function getBoundProviderSessionIdPin(meshSessionId: string | undefined): string | undefined {
    const key = typeof meshSessionId === 'string' ? meshSessionId.trim() : '';
    if (!key) return undefined;
    hydratePersistedProviderSessionPinsOnce();
    const pinned = lastBoundProviderSessionIdByMeshSession.get(key);
    return pinned && pinned.trim() ? pinned.trim() : undefined;
}

/**
 * Test-only: clear the in-memory read-pin map and re-arm cold-start hydration so
 * each test starts from a clean pin state. The on-disk mirror is isolated per
 * test process via ADHDEV_CONFIG_DIR (test/helpers/setup-env.ts); this resets the
 * module-level cache that would otherwise leak a pin across tests sharing the
 * worker. Not part of the runtime contract.
 */
export function __resetProviderSessionPinsForTest(): void {
    lastBoundProviderSessionIdByMeshSession.clear();
    persistedProviderSessionPinsHydrated = false;
    try { clearPersistedProviderSessionPins(); } catch { /* best-effort */ }
}

/**
 * Test-only: read the in-memory read-pin (the mesh-session → conversation-uuid
 * bind recorded by recordBoundProviderSessionId and mirrored to state.json
 * sessionProviderSessionPins). Lets the antigravity-coordinator-pin tests assert
 * that an owner-confirmed workspace-latest read recorded the pin — and that a
 * non-owner-confirmed read did NOT. Not part of the runtime contract.
 */
export function __getProviderSessionPinForTest(meshSessionId: string): string | undefined {
    return getBoundProviderSessionIdPin(meshSessionId);
}

export function getExplicitHistorySessionId(args: any): string | undefined {
    const explicit = typeof args?.historySessionId === 'string' ? args.historySessionId.trim() : '';
    if (explicit) return explicit;

    const explicitProviderSessionId = typeof args?.providerSessionId === 'string' ? args.providerSessionId.trim() : '';
    if (explicitProviderSessionId) return explicitProviderSessionId;

    return undefined;
}

/**
 * A native-history session id is a "runtime fallback" — the daemon's own
 * ADHDev session id (targetSessionId) standing in for a real provider-native
 * conversation uuid — when it exactly equals targetSessionId. For an
 * antigravity coordinator (agy takes no --session-id, so its providerSessionId
 * never surfaces to the web), getConversationHistorySessionId falls back to the
 * ADHDev sessionId, and the browser then sends that runtime id back as
 * args.historySessionId. That id is NOT the on-disk conversations/<uuid>.db
 * name (e.g. targetSessionId 28c530af vs stamped conv uuid 07f6ed3e), so a
 * native read keyed on it can never exact-bind — it fail-closes to pty-parser
 * (user-echo only) AND bypasses the owner-confirmed pin/live-bind resolution
 * (which only runs when historySessionId is empty). Detect it whether it
 * arrived EXPLICITLY (args.historySessionId === targetSessionId, the browser's
 * poisoned read) OR only via getHistorySessionId's internal fallback (empty
 * args), and in both cases treat historySessionId as ABSENT so the owner-
 * confirmed native resolution engages and returns [user, assistant, ...].
 * A REAL, DISTINCT provider conv uuid (≠ targetSessionId) is never a runtime
 * fallback and must still exact-bind as before.
 */
function isRuntimeFallbackHistorySessionId(
    candidateHistorySessionId: string | undefined,
    targetSessionId: string | undefined,
): boolean {
    const target = typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
    if (!target) return false;
    const candidate = typeof candidateHistorySessionId === 'string' ? candidateHistorySessionId.trim() : '';
    return candidate === target;
}

interface ResolvedNativeHistoryReadSession {
    /**
     * True when the candidate history id is the daemon runtime session id (==
     * targetSessionId) standing in for a real provider-native conv uuid — reached
     * either via getHistorySessionId's internal fallback (empty args) or because
     * the browser explicitly echoed targetSessionId back as historySessionId (the
     * poisoned agy-coordinator read). See isRuntimeFallbackHistorySessionId.
     */
    isRuntimeFallback: boolean;
    /** Owner-confirmed pin recorded by a prior bound read for this mesh session, if any. */
    pinnedProviderSessionId: string | undefined;
    /**
     * The id to key the native read on: the pin (or undefined) when the candidate
     * is a runtime fallback so pin / workspace-latest resolution engages, else the
     * candidate unchanged (a real DISTINCT provider uuid still exact-binds).
     */
    effectiveHistorySessionId: string | undefined;
}

/**
 * Resolve the runtime-fallback → pin substitution shared by every native-history
 * read path (handleChatHistory, the CLI-adapter main read, and the history-only
 * read). Each site previously inlined this same four-step computation verbatim:
 * detect the runtime fallback (candidate === targetSessionId AND no distinct
 * explicit id), look up the owner-confirmed pin, and drop the runtime id in favor
 * of the pin (or undefined) so readCliProviderNativeHistory's pin / workspace-
 * latest paths can engage instead of fail-closing to pty-parser. Extracted to a
 * single helper so the D9 historySessionId-poison guard has one definition.
 * Behavior is identical to the inlined blocks — same target (args.targetSessionId),
 * same explicit-id source, same pin key (getBoundProviderSessionIdPin trims).
 */
export function resolveNativeHistoryReadSession(
    args: any,
    candidateHistorySessionId: string | undefined,
): ResolvedNativeHistoryReadSession {
    const targetSid = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const explicitHistorySessionId = getExplicitHistorySessionId(args);
    const isRuntimeFallback = Boolean(
        targetSid
        && isRuntimeFallbackHistorySessionId(candidateHistorySessionId, targetSid)
        && (!explicitHistorySessionId
            || isRuntimeFallbackHistorySessionId(explicitHistorySessionId, targetSid)),
    );
    const pinnedProviderSessionId = getBoundProviderSessionIdPin(args?.targetSessionId);
    const effectiveHistorySessionId = isRuntimeFallback
        ? (pinnedProviderSessionId || undefined)
        : candidateHistorySessionId;
    return { isRuntimeFallback, pinnedProviderSessionId, effectiveHistorySessionId };
}

export function getHistorySessionId(h: CommandHelpers, args: any): string | undefined {
    const explicit = getExplicitHistorySessionId(args);
    if (explicit) return explicit;

    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId) return undefined;

    const session = h.ctx.sessionRegistry?.get(targetSessionId) as any;
    const registeredProviderSessionId = typeof session?.providerSessionId === 'string' ? session.providerSessionId.trim() : '';
    if (registeredProviderSessionId) return registeredProviderSessionId;

    const instance = getTargetInstance(h, args);
    const state = instance?.getState?.();
    const providerSessionId = typeof state?.providerSessionId === 'string' ? state.providerSessionId.trim() : '';
    if (providerSessionId) return providerSessionId;

    const currentSession = h.currentSession as any;
    if (currentSession?.sessionId === targetSessionId) {
        const currentProviderSessionId = typeof currentSession.providerSessionId === 'string'
            ? currentSession.providerSessionId.trim()
            : '';
        if (currentProviderSessionId) return currentProviderSessionId;
    }

    return targetSessionId;
}

export function resolveCliNativeHistorySessionId(args: any, currentHistorySessionId: string | undefined, parsedProviderSessionId: string | undefined): string | undefined {
    const explicit = getExplicitHistorySessionId(args);
    if (explicit) return explicit;

    const parsed = typeof parsedProviderSessionId === 'string' ? parsedProviderSessionId.trim() : '';
    const current = typeof currentHistorySessionId === 'string' ? currentHistorySessionId.trim() : '';
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';

    // getHistorySessionId falls back to the runtime session id when no native
    // handle has been registered yet. For live CLI adapters the parser may
    // already know the provider-native handle; prefer it over the runtime id so
    // exact native reads do not miss the worker transcript and fall back to PTY
    // or same-workspace history.
    if (parsed && (!current || current === targetSessionId)) return parsed;
    return current || parsed || undefined;
}

export function shouldSkipLiveCliNativeHistoryWithoutProviderSession(args: {
    adapter?: CliAdapter | null;
    providerType?: string;
    readChatArgs: any;
    nativeHistorySessionId?: string;
    parsedProviderSessionId?: string;
}): boolean {
    const explicit = getExplicitHistorySessionId(args.readChatArgs);
    if (explicit) return false;

    const targetSessionId = typeof args.readChatArgs?.targetSessionId === 'string'
        ? args.readChatArgs.targetSessionId.trim()
        : '';
    if (!targetSessionId) return false;

    const resolved = typeof args.nativeHistorySessionId === 'string'
        ? args.nativeHistorySessionId.trim()
        : '';
    if (!resolved || resolved !== targetSessionId) return false;

    const parsed = typeof args.parsedProviderSessionId === 'string'
        ? args.parsedProviderSessionId.trim()
        : '';
    if (parsed) return false;

    const cliType = args.adapter?.cliType || args.providerType || '';
    if (cliType !== 'codex-cli') return false;

    // A live Codex session starts with only the daemon runtime UUID. That UUID
    // is not the provider-native rollout id, so using it for native history
    // lets the file picker fall back to the newest same-workspace transcript
    // and makes concurrent fresh sessions all show the same old conversation.
    return !!args.adapter;
}

function getInteractionId(args: any): string | undefined {
    return typeof args?._interactionId === 'string' && args._interactionId.trim()
        ? args._interactionId.trim()
        : undefined;
}

export function traceProviderEvent(
    args: any,
    category: 'provider' | 'parser',
    stage: string,
    options: {
        h: CommandHelpers;
        provider?: ProviderModule;
        payload?: Record<string, unknown>;
        level?: 'debug' | 'info' | 'warn' | 'error';
    },
): void {
    recordDebugTrace({
        interactionId: getInteractionId(args),
        category,
        stage,
        level: options.level || 'info',
        sessionId: typeof args?.targetSessionId === 'string' ? args.targetSessionId : options.h.currentSession?.sessionId,
        providerType: options.provider?.type || options.h.currentProviderType || options.h.currentSession?.providerType,
        payload: options.payload,
    });
}
