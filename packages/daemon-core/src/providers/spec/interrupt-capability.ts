/**
 * Turn-interrupt capability resolution for spec-driven CLI providers.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * Steering a session that is ALREADY generating cannot be done by writing the
 * new prompt into its PTY. A raw write into a mid-generation TUI is not consumed
 * as a new turn: the bytes sit in the input buffer, the LLM never reads them,
 * and yet the caller gets a success signal (see the NOTIF-SURFACE-LOCAL RCA in
 * mesh-reconcile-loop.ts). That is why the force-inject path was retired and the
 * `force` option is inert on the spec path (SpecCliAdapter.sendMessage ignores
 * its opts; forceSendMessage is not implemented here at all).
 *
 * The only honest way to change a running session's trajectory is to INTERRUPT:
 * press the CLI's own stop control, let the FSM observe busy→idle, and let the
 * ordinary queued-send drain deliver the new prompt as a genuine turn. The turn
 * in flight is LOST — that is inherent, not a defect, and the naming throughout
 * this feature says so.
 *
 * ── Why capability must be read from the RESOLVED spec ────────────────────
 * The stop key is per-provider AND per-spec-version, so a hardcoded table would
 * be wrong the moment a provider ships a new spec. Measured 2026-08-19:
 *
 *   antigravity-cli 1.0/4.0  ESC  (\x1b)   <- the one ESC provider
 *   claude-cli 3.0/4.0       Ctrl-C (\x03)
 *   codex-cli 0.137/4.0      Ctrl-C
 *   cursor-cli 1.0           Ctrl-C
 *   grok-cli 1.0             Ctrl-C
 *   hermes-cli 0.14          Ctrl-C
 *   hermes-cli 4.0           ""   <- DECLARED BUT EMPTY
 *   kimi 1.0                 Ctrl-C
 *   opencode 1.0             Ctrl-C
 *
 * hermes-cli is the reason this is a resolver and not a lookup table: its
 * compatibility map routes every install `>=0.14.0` to specs/4.0.json, whose
 * stop control declares `keys: ""`. FsmDriver.handleClickControl would call
 * send_keys("") — writing nothing — while SpecCliAdapter.invokeScript returns
 * `{ ok: true, effects: [{ type: 'sent_keys' }] }` regardless. Routing an
 * interrupt through that path would reproduce the exact defect class this work
 * exists to remove: a success signal that does not match reality. So an empty
 * key sequence is classified UNSUPPORTED here, before anything is written.
 *
 * NOTE ON SCOPE: only claude-cli's mid-generation write behaviour was ever
 * measured directly. The stop-key DECLARATIONS below are measured for all
 * providers, but "pressing stop actually aborts the turn and returns the TUI to
 * an idle prompt" is verified live only for claude-cli. Providers are therefore
 * reported as `declared` rather than `proven`; see InterruptCapability.confidence.
 */

import type { Control } from './types.js';

/** Ctrl-C — the interrupt key for every shipped provider except antigravity. */
export const CTRL_C = '\x03';
/** ESC — antigravity-cli's stop key. */
export const ESC = '\x1b';

/** The control id every shipped spec uses for its stop/interrupt control. */
export const STOP_CONTROL_ID = 'stop';

export type InterruptUnsupportedReason =
    /** The spec declares no control_bar entry with id 'stop'. */
    | 'no_stop_control'
    /** A stop control exists but its action is not a key write (e.g. open_picker). */
    | 'stop_control_not_send_keys'
    /** A stop control exists and is send_keys, but the key sequence is empty
     *  (hermes-cli specs/4.0.json). Pressing it writes nothing. */
    | 'stop_keys_empty';

export type InterruptCapability =
    | {
          supported: true;
          /** Exact byte sequence to write to the PTY to abort the current turn. */
          keys: string;
          /** Human-readable key name for logs/telemetry — 'ESC' | 'Ctrl-C' | 'custom'. */
          keyName: string;
          /**
           * How well this provider's interrupt is verified.
           *   'proven'   — observed live to abort a turn and return to idle.
           *   'declared' — the spec declares a non-empty stop key, but the
           *                busy→idle effect has not been observed live here.
           * Callers MUST surface 'declared' to the operator rather than
           * presenting an unverified interrupt as a guaranteed one.
           */
          confidence: 'proven' | 'declared';
          /** Spec states in which the stop control is declared visible. An
           *  interrupt attempted outside these states is silently dropped by
           *  FsmDriver.handleClickControl, so callers check this first. */
          visibleWhenState?: string[];
      }
    | {
          supported: false;
          reason: InterruptUnsupportedReason;
          /** Operator-facing explanation — never swallowed, always reported. */
          message: string;
      };

/**
 * Providers whose interrupt has been observed live (not merely declared).
 * Deliberately conservative: claude-cli is the only provider for which
 * mid-generation behaviour was directly measured. Adding an entry here is a
 * claim that someone watched the turn actually abort — do not add a provider
 * because its spec "looks the same".
 */
const LIVE_VERIFIED_PROVIDERS = new Set<string>(['claude-cli']);

function nameForKeys(keys: string): string {
    if (keys === CTRL_C) return 'Ctrl-C';
    if (keys === ESC) return 'ESC';
    return 'custom';
}

/**
 * Resolve whether a spec-driven provider can have its current turn interrupted,
 * reading the provider's OWN resolved spec rather than any hardcoded mapping.
 *
 * Fail-closed: anything that is not a declared, non-empty key write is
 * unsupported, with a reason the caller is expected to report upward.
 */
export function resolveInterruptCapability(
    providerType: string,
    controlBar: Control[] | undefined,
): InterruptCapability {
    const stop = (controlBar ?? []).find(c => c.id === STOP_CONTROL_ID);
    if (!stop) {
        return {
            supported: false,
            reason: 'no_stop_control',
            message: `Provider '${providerType}' declares no '${STOP_CONTROL_ID}' control, so a running turn cannot be interrupted. `
                + 'Dispatch with delivery mode when_idle and the task will be delivered once the session finishes on its own.',
        };
    }
    if (stop.action?.type !== 'send_keys') {
        return {
            supported: false,
            reason: 'stop_control_not_send_keys',
            message: `Provider '${providerType}' declares a '${STOP_CONTROL_ID}' control of type '${stop.action?.type}', not a key write, `
                + 'so it cannot be used to abort a turn. Dispatch with delivery mode when_idle instead.',
        };
    }
    const keys = stop.action.keys;
    if (typeof keys !== 'string' || keys.length === 0) {
        return {
            supported: false,
            reason: 'stop_keys_empty',
            message: `Provider '${providerType}' declares a '${STOP_CONTROL_ID}' control with an EMPTY key sequence, so pressing it would write `
                + 'nothing to the terminal while still reporting success. Treating this as unsupported rather than silently doing nothing. '
                + 'Dispatch with delivery mode when_idle, or fix the provider spec to declare a real stop key.',
        };
    }
    return {
        supported: true,
        keys,
        keyName: nameForKeys(keys),
        confidence: LIVE_VERIFIED_PROVIDERS.has(providerType) ? 'proven' : 'declared',
        ...(stop.visible_when_state ? { visibleWhenState: stop.visible_when_state } : {}),
    };
}
