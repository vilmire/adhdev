// ---------------------------------------------------------------------------
// Approval-gate and mesh-stall tuning constants for CliProviderInstance.
//
// Pure move out of cli-provider-instance.ts (file-size gate decomposition,
// mission B1 — that file sat 4 lines under the 2,400 threshold while carrying
// the repo's highest churn, so the next ordinary feature commit would have
// tripped `new-oversize`). Values and derivations are byte-identical to the
// `private static readonly` block they came from; only the declaration form
// changed (class static -> module constant).
//
// ★ The class still declares each of these as a `private static readonly`
// aliasing the constant below, because tests read them off the class
// (`(CliProviderInstance as any).AUTO_APPROVE_SETTLE_MS` — see
// cli-provider-auto-approve-{settle,mask-stall,flap-recur}.test.ts). Moving the
// documentation out without keeping the statics would break those reads, so the
// aliases are load-bearing, not vestigial.
// ---------------------------------------------------------------------------
import * as approvalGate from './completion/approval-gate.js';

/**
 * Quiet period an approval modal's signature must be stable before
 * auto-approve sends the approve key. Guards against firing on a prompt
 * that is still streaming into the PTY (the "resolves too fast" symptom):
 * while the modal text/buttons are still changing, every frame yields a
 * new signature and the settle clock restarts. Once the prompt finishes
 * rendering the signature holds and the key is sent after this window.
 * Bounded + small so genuine approvals stay timely. The FSM is already
 * authoritative over the `waiting_approval` state; this only delays the
 * keystroke until the modal *content* has settled.
 */
export const AUTO_APPROVE_SETTLE_MS = approvalGate.APPROVAL_SETTLE_MS;

/**
 * APPROVAL-INBOX-BLINDSPOT (Fix A): how long after a LOCAL auto-approve fire the mesh
 * event forwarder still treats the modal as "being resolved locally" and suppresses the
 * coordinator notification. Chosen to comfortably cover the resolveModal → PTY absorb →
 * status-leaves-approval round trip (incl. the win32 CR-resend loop) while staying short
 * enough that a modal which auto-approve fired at but did NOT resolve re-surfaces to the
 * coordinator on the next event. Aligned with the adapter's own approval cooldown scale.
 */
export const APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS = 8000;

/**
 * Busy-side hysteresis for the settle gate. A momentary `generating` flip
 * while the SAME approval modal's button block is still on screen (its
 * question line scrolled out of the captured frame, only the buttons + a
 * residual `esc to interrupt` spinner remain) briefly reports
 * status!=waiting_approval. Without hysteresis that flip wipes the settle
 * clock, and the modal→generating→modal flap restarts the 600ms window
 * every time so auto-approve never fires. We keep the in-progress settle
 * gate warm across an inactive blip up to this bound; only once the modal
 * has genuinely stayed gone this long (a real resolution → idle) is the
 * gate cleared. Bounded so a genuinely new, later approval still re-settles
 * from scratch rather than firing on a stale timestamp.
 */
export const AUTO_APPROVE_GATE_HYSTERESIS_MS = approvalGate.APPROVAL_GATE_HYSTERESIS_MS;

/**
 * AUTOAPPROVE-FLAP-RECUR (Fix B): extended busy-side continuity window for a
 * DELEGATED-WORKER auto-approve episode that is genuinely still cycling.
 *
 * The default AUTO_APPROVE_GATE_HYSTERESIS_MS (1500) absorbs a *momentary*
 * `generating` blip. But a delegated worker running a Bash approval observed
 * the FSM cycle the FULL state waiting_approval → busy → waiting_approval on a
 * 2–5s period (the button set scrolls in/out AND the modal question repaints,
 * so the adapter genuinely reports status=generating for whole seconds between
 * approval frames). Each busy phase outran the 1500ms hysteresis, so the
 * settle clock was WIPED (the genuine-resolution branch), the 600ms settle
 * window never accumulated across the flap, resolveModal never fired
 * (resolveModal count 0), and the mask-stall clock instead tripped at 4500ms →
 * coordinator nudge → the flap the coordinator observed.
 *
 * A genuine resolution and a flap both start with a busy phase; they diverge
 * only in whether waiting_approval RETURNS. So we cannot simply lengthen the
 * blanket hysteresis (that would make every real resolution hold the gate
 * open for seconds). Instead this longer window applies ONLY while an active
 * mask episode is alive (autoApproveMaskSince > 0) AND the session is a
 * delegated worker — i.e. exactly the never-resolving-flap case. A foreground
 * / attended session keeps the tight 1500ms window unchanged. The mask-stall
 * bound below still caps the episode, so a worker whose approval truly never
 * returns is surfaced to the coordinator within AUTO_APPROVE_MASK_STALL_MS
 * rather than held forever.
 *
 * INVARIANT (do not regress the ordering): this window must fully BRIDGE a
 * single busy phase, and the mask-stall bound below must in turn exceed it —
 * AUTO_APPROVE_MASK_STALL_MS > AUTO_APPROVE_FLAP_CONTINUITY_MS + max_busy_phase
 * + AUTO_APPROVE_SETTLE_MS. Observed flap geometry (delegated-worker Bash
 * approval): approval frames last ~1.5s, busy phases (modal=none) last
 * ~4.3–4.5s. With the old 4000ms this window was SHORTER than a busy phase, so
 * the settle clock was torn down every cycle and never accrued 600ms while the
 * 4500ms mask-stall tripped INSIDE the first busy phase → a stalled-approval
 * nudge leaked to the coordinator. 6000ms bridges the ~4.5s busy phase with
 * margin so the returning approval frame survives to resume its settle clock.
 */
export const AUTO_APPROVE_FLAP_CONTINUITY_MS = approvalGate.APPROVAL_FLAP_CONTINUITY_MS;

/**
 * STATUS-MISMATCH: upper bound on how long the auto-approve→`generating` SURFACE
 * mask may hide a worker's `waiting_approval` (status + activeModal) before we give
 * up and surface the real prompt. The mask exists because auto-approve is expected
 * to resolve the modal momentarily; but if it STALLS without ever calling
 * resolveModal — the modal signature never settles for AUTO_APPROVE_SETTLE_MS (a
 * perpetually-flapping/streaming prompt), no concrete modal is ever captured, or the
 * modal is a picker/non-affirmative we never auto-pick — the mask would persist
 * forever and read_chat / mesh_status / the dashboard would NEVER see the pending
 * approval (the coordinator cannot mesh_approve what it cannot see). Once an episode
 * exceeds this bound we stop masking. Generously larger than
 * AUTO_APPROVE_SETTLE_MS (600) + AUTO_APPROVE_GATE_HYSTERESIS_MS (1500) so a
 * legitimately slow-settling / blip-flapping prompt is never unmasked early; a
 * genuine never-resolving stall surfaces within this window. The settle gate keeps
 * running underneath, so a prompt that finally stabilises still auto-approves, and
 * mesh_approve (raw FSM, unmasked) works throughout.
 *
 * INVARIANT (do not regress): must be STRICTLY GREATER than
 * AUTO_APPROVE_FLAP_CONTINUITY_MS + max_busy_phase + AUTO_APPROVE_SETTLE_MS so
 * that during a flap the settle clock (which FLAP_CONTINUITY keeps alive across
 * each busy phase) gets to accrue its 600ms on the RETURNING approval frame
 * before this stall bound can trip. Observed geometry — worker: approval ~1.5s,
 * busy ~4.3–4.5s; coordinator self-session: approval ~1.5s, busy ~2.85s. Both
 * now use the extended window (isAutonomousMeshSession covers worker +
 * meshCoordinatorFor). Worst case: CONTINUITY(6000) + busy(~4.5s) + SETTLE(600)
 * = ~11100ms, so the stall bound must exceed that. 10500ms satisfies the invariant
 * for coordinator (6000 + 2850 + 600 = 9450 < 10500) and was previously 9000ms
 * (which failed for a worker busy phase of 4.5s: 6000+4500+600=11100 > 9000).
 * the old 4500ms tripped inside the very first busy phase (while modal=none, so
 * the nudge was NOT deferred) and leaked to the coordinator.
 */
export const AUTO_APPROVE_MASK_STALL_MS = approvalGate.APPROVAL_AUTO_MASK_STALL_MS;

/**
 * AUTOAPPROVE-FLAP-INBOX-MISSING: sticky-approval overlay window. Same time-tick
 * hold idea as the FALSE-IDLE completion gate — an approval signal that was
 * DOMINANT within this recent window is re-presented across a momentary busy blip
 * instead of collapsing.
 *
 * RCA (live 2026-07-13): a claude-cli worker sitting at a Bash approval modal
 * ("Do you want to proceed? ❯1.Yes") flaps waiting_approval↔busy on a ~2-3s period.
 * The spec `approval→busy` transition fires whenever the footer/modal approval
 * markers momentarily drop out of their parsed sections while the PRIOR command's
 * residual spinner text ("✳ Checking vendor drift…") still matches the busy regex.
 * On the busy frame the adapter reports status='generating', activeModal=null. That
 * corrupts THREE consumers at once: (1) mesh_active_work samples 'generating' →
 * collectPendingApprovals never sees 'awaiting_approval' → mesh_list_pending_approvals
 * count:0 (inbox miss); (2) the auto-approve settle gate is torn down each busy phase
 * so the 600ms settle never accrues → auto-approve never fires; (3) a mesh_approve
 * landing on a busy frame hits "Not in approval state". The existing FLAP machinery
 * (AUTO_APPROVE_FLAP_CONTINUITY_MS) only keeps the settle gate warm while status is
 * STILL waiting_approval (buttons scrolled out) — it does nothing once the FSM fully
 * commits to 'busy', and it never stabilises the status the inbox samples.
 *
 * Fix: when the raw adapter status flaps to generating/busy/idle but a
 * waiting_approval WITH a concrete modal was observed within this window, overlay
 * the cached modal and report status='waiting_approval'. This stabilized status
 * feeds getState (→ inbox), detectStatusTransition (→ event emission), and
 * maybeAutoApproveStatus (→ settle gate) uniformly, so the approval both registers
 * in the inbox and settles for auto-approve across the flap. Bounded (a genuine
 * resume that never returns to approval unmasks after this window) and scoped at the
 * call site to autonomous mesh sessions. 4000ms bridges the observed ~2-3s flap with
 * margin while staying well under AUTO_APPROVE_MASK_STALL_MS (a truly stalled/absent
 * approval still surfaces).
 */
export const APPROVAL_STICKY_FLAP_MS = approvalGate.APPROVAL_STICKY_FLAP_MS;

/**
 * FALSE-IDLE (inter-approval quiet valley): grace window after an auto-approve
 * (or mesh_approve) RESOLVES a modal during which a subsequent generating→idle
 * quiet valley must NOT be treated as turn completion.
 *
 * The RCA: auto-approve resolves a modal → the agent resumes the same turn →
 * between resolving that approval and preparing the next tool/approval the agent
 * falls briefly silent. The FSM sees idle + a recorded mid-turn assistant bubble
 * and fires an early agent:generating_completed even though the turn is still in
 * flight. Live evidence showed the same session resuming waiting_approval ~13s
 * after a "clean" completion emit.
 *
 * The window must be comfortably larger than the observed resume gap (~13s) so
 * the valley is bridged, but not so large that a turn that genuinely ended right
 * after an approval is held for an annoying stretch. 18s clears 13s with margin
 * while capping the worst-case extra hold on a truly-finished turn at 18s (still
 * well under COMPLETED_FINALIZATION_MAX_WAIT_MS's 30s hard bound). The recency is
 * measured from the engine's lastApprovalResolvedAt, which is stamped ONLY by
 * resolveModal (auto-approve fire / dashboard / mesh_approve) — so a plain turn
 * with no approval never carries recency and is never held (no regression).
 */
export const APPROVAL_RESUME_GRACE_MS = 18_000;

// MESH-STALL-WATCH (feature 1: STALL detection): how long a coordinator-spawned
// mesh worker's raw PTY output (lastOutputAt) may stay unchanged before the
// status-agnostic stall watchdog fires ONE informational monitor:no_progress
// event. Unlike the StatusMonitor no-progress watchdog (which only runs while a
// turn is generating), this observes pure screen stasis regardless of the
// reported status — a worker parked idle, wedged mid-turn, or spawned with no
// output at all.
//
// FALSE-STALL-WATCHDOG-OVERFIRE (fix C): the threshold is now turn-scoped. When
// an explicit turn is in flight (hasAdapterPendingResponse() — the adapter's
// currentTurnScope / isWaitingForResponse / isProcessing / partial buffer), a
// long silent thinking gap (claude-cli opus/high can go minutes between visible
// tokens) is normal, so the bar is raised to MESH_WORKER_STALL_TURN_THRESHOLD_MS.
// Outside a turn (idle) the tighter MESH_WORKER_STALL_IDLE_THRESHOLD_MS applies.
// This is a THRESHOLD RAISE, not a suppression: a genuine mid-turn wedge still
// fires (late, at the turn bound) rather than being hidden behind a sticky
// generating status. 180s matches DEFAULT_MONITOR_CONFIG.noProgressThresholdSec
// so the idle bound agrees with the StatusMonitor watchdog's "long interval".
export const MESH_WORKER_STALL_IDLE_THRESHOLD_MS = 180_000;
export const MESH_WORKER_STALL_TURN_THRESHOLD_MS = 360_000;
// FALSE-STALL-WATCHDOG-OVERFIRE (fix E): minimum spacing between two stall
// notifications for the SAME session, even across anchor re-arms. The
// per-anchor meshStallEmittedForAnchor guard already stops a single continuous
// stall from re-firing; this cooldown additionally throttles the churn where a
// worker dribbles one byte every few minutes (each re-arming the anchor and then
// re-crossing the bar), which would otherwise page the coordinator repeatedly.
// The stall is still fired for observability — just not more than once per
// window per session. Set larger than the stall thresholds so consecutive
// re-armed stalls a few minutes apart collapse into a single notification.
export const MESH_WORKER_STALL_REFIRE_COOLDOWN_MS = 600_000;
