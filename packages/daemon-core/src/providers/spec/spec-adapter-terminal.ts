/**
 * Mesh terminal operations of the spec-path adapter: the raw viewport read
 * (mesh_read_terminal), turn interrupt, and structured key injection
 * (mesh_send_keys). Split out of cli-adapter.ts (file-size gate); each reads
 * the adapter only through {@link SpecTerminalHost}.
 */
import { createHash } from 'node:crypto';
import type { ISpecDriver } from './fsm-driver-types.js';
import type { FsmStatus } from './fsm-types.js';
import type { InterruptCapability, InterruptUnsupportedReason } from './interrupt-capability.js';
import {
    encodeMeshSendKeys,
    truncateToByteTailByLine,
    type MeshSendKeyItem,
    type MeshSendKeyName,
} from '../../cli-adapters/provider-cli-shared.js';
import { LOG } from '../../logging/logger.js';

export interface SpecTerminalHost {
    readonly cliType: string;
    readonly cliName: string;
    readonly driver: Pick<ISpecDriver, 'dispatch'>;
    /** spawned && !exited */
    readonly running: boolean;
    readonly latestState: { id: string; status: FsmStatus } | null;
    readonly latestModal: { buttons: { index: number; label: string }[] } | null;
}

export interface TerminalScreenSnapshot {
    text: string;
    cursor: { col: number; row: number };
    cols: number;
    rows: number;
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    hash: string;
}

// MESH-READ-TERMINAL / MESH-SEND-KEYS byte caps — same envelope as
// ProviderCliAdapter (32KiB default view, 64KiB absolute hard cap). Bytes,
// not chars: a multi-byte-glyph screen can exceed an MCP payload cap while
// the char count still looks safe.
const TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES = 32 * 1024;
const TERMINAL_SNAPSHOT_ABSOLUTE_MAX_BYTES = 64 * 1024;

/**
 * MESH-READ-TERMINAL (feature 2: RAW terminal read). Least-privilege read
 * of the CURRENT rendered viewport for mesh_read_terminal on the spec path
 * (claude-cli / antigravity / codex-cli — the native-source providers that
 * route through SpecCliAdapter). Mirrors ProviderCliAdapter.getTerminalScreenSnapshot:
 *  - returns ONLY the driver's current viewport snapshot, the cursor
 *    position and the terminal geometry — NO scrollback, NO parser/FSM
 *    state, NO debug buffers;
 *  - the payload is byte-bounded (UTF-8) with bottom-tail preservation so a
 *    screen of multi-byte glyphs can never exceed the MCP payload cap;
 *  - `hash` is over the FULL untruncated viewport so a caller can detect a
 *    screen change across polls even when the returned text was truncated.
 *
 * SECURITY: the raw viewport can carry tokens / command args / env / user
 * data. Callers MUST gate this on mesh ownership and MUST NOT log the text.
 */
export function readTerminalScreenSnapshot(
    driver: Pick<ISpecDriver, 'snapshot' | 'getCursorPosition' | 'getScreenSize'>,
    maxBytes = TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES,
): TerminalScreenSnapshot {
    const cap = Math.min(
        TERMINAL_SNAPSHOT_ABSOLUTE_MAX_BYTES,
        Math.max(1024, Math.floor(maxBytes) || TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES),
    );
    let rawViewport = '';
    try { rawViewport = driver.snapshot() || ''; } catch { rawViewport = ''; }
    let cursor = { row: 0, col: 0 };
    try { cursor = driver.getCursorPosition(); } catch { /* keep 0,0 */ }
    // getScreenSize is optional on ISpecDriver; a test double may omit it.
    let size = { cols: 0, rows: 0 };
    try { size = driver.getScreenSize?.() ?? size; } catch { /* keep 0,0 */ }
    const truncation = truncateToByteTailByLine(rawViewport, cap);
    const hash = createHash('sha256').update(rawViewport, 'utf8').digest('hex').slice(0, 16);
    return {
        text: truncation.text,
        cursor: { col: cursor.col, row: cursor.row },
        cols: size.cols,
        rows: size.rows,
        truncated: truncation.truncated,
        originalBytes: truncation.originalBytes,
        returnedBytes: truncation.returnedBytes,
        hash,
    };
}

/**
 * Abort the turn currently in flight by writing the provider's own stop
 * key to the PTY. Used by delivery mode 'interrupt': the caller then waits
 * for the FSM to report idle and lets the ordinary queued-send drain
 * deliver the new prompt as a genuine new turn.
 *
 * ★ Deliberately NOT routed through invokeScript('stop'). That path calls
 * FsmDriver.handleClickControl, which silently returns when the control's
 * `visible_when_state` does not include the current state, and calls
 * send_keys("") for a provider whose stop key is empty — while
 * invokeScript unconditionally returns `{ ok: true, effects:[sent_keys] }`
 * either way. Reporting a successful interrupt that wrote nothing is
 * exactly the failure this feature exists to remove, so capability is
 * validated HERE, before any write, and the outcome is reported honestly.
 */
export async function interruptSpecTurn(host: SpecTerminalHost, capability: InterruptCapability): Promise<
    | { ok: true; keyName: string; bytes: number; confidence: 'proven' | 'declared' }
    | { ok: false; reason: InterruptUnsupportedReason | 'not_running' | 'not_busy'; message: string }
> {
    if (!host.running) {
        return { ok: false, reason: 'not_running', message: `${host.cliName} is not running.` };
    }
    const cap = capability;
    if (!cap.supported) {
        LOG.warn('SpecAdapter', `[${host.cliType}] interrupt refused: ${cap.reason}`);
        return { ok: false, reason: cap.reason, message: cap.message };
    }
    // Interrupting a session that is not generating would write a stray
    // Ctrl-C/ESC at an idle prompt. Report it instead of writing blindly.
    const status = host.latestState?.status;
    if (status !== 'generating') {
        return {
            ok: false,
            reason: 'not_busy',
            message: `Session is '${status ?? 'unknown'}', not generating — nothing to interrupt.`,
        };
    }
    host.driver.dispatch({ kind: 'pty_write', data: cap.keys });
    const bytes = Buffer.byteLength(cap.keys, 'utf8');
    LOG.info('SpecAdapter', `[${host.cliType}] turn interrupted via ${cap.keyName} (bytes=${bytes}, confidence=${cap.confidence})`);
    return { ok: true, keyName: cap.keyName, bytes, confidence: cap.confidence };
}

/**
 * MESH-SEND-KEYS (feature 3: key injection). Inject a STRUCTURED key
 * sequence into the spec-driven PTY for mesh_send_keys. Mirrors
 * ProviderCliAdapter.injectKeys' modal fail-closed guard, then writes the
 * whole encoded sequence in ONE pty_write dispatch (text+ENTER is a single
 * contiguous string, so a submit key can never be separated from the text
 * it submits).
 *
 * The spec path drives the child through the FsmDriver, not a directly-held
 * ptyProcess — there is no adapter-level echo-gate/submit-retry FIFO to race
 * against here (the driver serializes its own writes). A send_keys call is
 * refused while the session is generating: input can otherwise sit in the
 * PTY buffer while the active turn continues, and CTRL_C/ESC would bypass the
 * interrupt capability gate. Use mesh_send_task with delivery_mode:'interrupt'
 * to steer an active turn. The modal fail-closed guard remains: a
 * NON-destructive injection into an actionable approval modal is refused (use
 * mesh_approve) unless explicitly overridden.
 * A destructive ESC/CTRL_C dismisses rather than confirms, so it is allowed
 * past this gate (the tool layer owns the destructive double-gate + audit).
 * This method NEVER logs the literal text — only key enums / byte length.
 */
export async function injectSpecKeys(
    host: SpecTerminalHost,
    items: MeshSendKeyItem[],
    opts: { allowModalOverride?: boolean } = {},
): Promise<
    | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
    | { ok: false; refused: 'submit_race' | 'actionable_modal' | 'generating'; keys: MeshSendKeyName[]; hasDestructive: boolean; message?: string }
> {
    if (!host.running) throw new Error(`${host.cliName} is not running`);
    const encoded = encodeMeshSendKeys(items);

    // Modal fail-closed — a NON-destructive injection while parked on an
    // ACTIONABLE approval modal is refused so a modal choice can't be
    // confirmed via send_keys and bypass the approval policy.
    //
    // APPROVAL-DEADLOCK (live 2026-09-20, grok-cli trust + antigravity-cli
    // permission prompt): the guard used to arm on `status === 'approval'`
    // alone. That status comes from statusForState(), which reports
    // 'approval' for ANY `modal: true` state — INDEPENDENT of whether the
    // spec's button rule actually parsed any buttons. mesh_approve, on the
    // other hand, can only press a button that parsed (deriveModal returns
    // null when the rule is missing or matches nothing). So a modal the spec
    // could not parse armed the send_keys guard while disarming approve, and
    // the session had ZERO ways to answer the prompt on screen:
    //     mesh_approve   → "the modal could not be actioned"
    //     mesh_send_keys → "refused: actionable_modal"
    // Both observed cases were spec-side (grok's `trust` state declared no
    // extract.buttons at all; antigravity's cursor_marker omitted the `>` the
    // screen paints), and both specs are fixed alongside this change — but a
    // spec gap must never again be able to wedge a session with no way out.
    //
    // So the guard now arms on what its own name claims: an actionable modal
    // = a modal state WITH parsed buttons, which is exactly the condition
    // under which mesh_approve has something to press. When no buttons
    // parsed, approve cannot act, so send_keys is the only remaining path
    // and is allowed through (the caller still owns its own audit trail).
    // This narrows the guard ONLY in the case where the path it redirects to
    // is provably unavailable, so the approval-policy bypass it exists to
    // prevent stays closed for every modal that can actually be approved.
    const modalActive = host.latestState?.status === 'approval';
    const parsedButtonCount = host.latestModal?.buttons?.length ?? 0;
    if (modalActive && parsedButtonCount > 0 && !encoded.hasDestructive && !opts.allowModalOverride) {
        LOG.warn('SpecAdapter', `[${host.cliType}] send_keys refused (actionable_modal): keys=${encoded.keys.join(',')} buttons=${parsedButtonCount} — use mesh_approve`);
        return { ok: false, refused: 'actionable_modal', keys: encoded.keys, hasDestructive: encoded.hasDestructive };
    }
    if (modalActive && parsedButtonCount === 0) {
        // Loud on purpose: this is the escape hatch firing, and it means the
        // loaded spec could not parse the modal on screen. Surfacing it here
        // is what turns a silent deadlock into a diagnosable spec bug.
        LOG.warn('SpecAdapter', `[${host.cliType}] send_keys ALLOWED past the modal guard — state '${host.latestState?.id ?? '?'}' is modal but the loaded spec parsed 0 buttons, so mesh_approve cannot act on it. Fix the spec's extract.buttons rule for this screen; send_keys is the only path until then.`);
    }

    // Fail closed while an active turn owns the PTY. Blindly writing here can
    // leave bytes buffered until after the turn.
    //
    // A DESTRUCTIVE key (ESC / CTRL_C) is exempt, matching the modal guard
    // 8 lines up and the contract stated in this method's doc comment. It
    // dismisses rather than confirms, so it cannot commit anything a policy
    // gate would have refused, and the tool layer owns its double-gate +
    // audit. Without the exemption a session wedged on an unanswerable
    // screen — a first-run onboarding TUI reported as `generating` — has no
    // manual escape hatch at all: mesh_send_task's interrupt path needs a
    // real turn to interrupt, which is exactly what such a session lacks.
    if (host.latestState?.status === 'generating' && !encoded.hasDestructive) {
        const message = "session is generating; mesh_send_keys cannot write during an active turn. Use mesh_send_task with delivery_mode: 'interrupt' to interrupt it.";
        LOG.warn('SpecAdapter', `[${host.cliType}] send_keys refused (generating): keys=${encoded.keys.join(',')} — use mesh_send_task delivery_mode=interrupt`);
        return { ok: false, refused: 'generating', keys: encoded.keys, hasDestructive: encoded.hasDestructive, message };
    }

    // Atomic write: the full encoded sequence goes out in ONE pty_write.
    host.driver.dispatch({ kind: 'pty_write', data: encoded.sequence });
    LOG.info('SpecAdapter', `[${host.cliType}] send_keys injected keys=${encoded.keys.join(',') || '(text-only)'} bytes=${Buffer.byteLength(encoded.sequence, 'utf8')} destructive=${encoded.hasDestructive}`);
    return {
        ok: true,
        keys: encoded.keys,
        hasDestructive: encoded.hasDestructive,
        submits: encoded.submits,
        bytes: Buffer.byteLength(encoded.sequence, 'utf8'),
    };
}
