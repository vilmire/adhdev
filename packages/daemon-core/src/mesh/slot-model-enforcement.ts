/**
 * Slot model enforcement — a model the matched node capability slot does not
 * declare must never reach the launch arguments.
 *
 * WHY THIS EXISTS: the difficulty→brain presets (DEFAULT_DIFFICULTY_BRAINS) stamp
 * a model onto a task at enqueue time — `difficult` → `opus`. The assignment path
 * then treated the explicit `task.model` as the winner and let the matched slot
 * fill blanks only. So a `difficult` task landing on a node whose only slot is
 * `{ provider: 'claude-cli', model: 'sonnet' }` launched with `--model opus`,
 * a model that node never declared.
 *
 * The invariant this enforces: **the launch model is always one the matched slot
 * declares.** An operator who configures slots in the UI has stated what may run
 * on that node; a preset must not silently widen that set. This holds regardless
 * of whether the undeclared model would actually be billed — an undeclared model
 * entering the execution path is itself the defect.
 *
 * Owner-specified resolution (decideSlotForModel) — three branches, where 'busy'
 * and 'absent' must NOT share a code path because their nature is opposite:
 *   1. declaring slot with capacity → run
 *   2. declaring slot exists, all at maxParallel → WAIT in the queue. Transient;
 *      it resolves itself when the slot goes idle, so paging would be noise.
 *   3. no declaring slot at all → NOTIFY the coordinator. Permanent; waiting can
 *      never help, and sitting silently pending forever is the worst outcome.
 *
 * Substituting a different model is explicitly rejected: silently downgrading to
 * a model the user never selected violates the same principle as running an
 * undeclared one.
 *
 * Relationship to model-provider-compat.ts (CODEX-400 GUARD): that guard answers
 * "can this provider physically accept this model string?" and drops Anthropic
 * models sent to non-Anthropic providers. This module answers the different
 * question "did the operator declare this model for this slot?". They compose —
 * compat runs after enforcement, so a substituted slot model is still checked
 * against the provider.
 *
 * NAME MATCHING: slot models are written in whatever vocabulary the provider's UI
 * uses, so the SAME model appears as `opus`, `claude-opus-4-6`, or
 * `Claude Opus 4.6 (Thinking)` (the last is a real production slot value). A raw
 * string compare here would reproduce this repo's canon-identity defect class —
 * declaring a match "different" purely because of surface form, and downgrading a
 * correctly-configured slot. Matching therefore goes through a canonical identity
 * (family + version), never a raw `===`.
 */
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared';

/** Known Claude model families. */
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku'] as const;

/**
 * Canonical identity of a model name: `{ family, version }`.
 *
 * Derived from any surface form:
 *   'opus'                        → { family: 'opus', version: undefined }
 *   'claude-opus-4-6'             → { family: 'opus', version: '4.6' }
 *   'Claude Opus 4.6 (Thinking)'  → { family: 'opus', version: '4.6' }
 *
 * A non-Claude / unrecognized model has no family; callers fall back to a
 * normalized literal compare for those (e.g. 'kimi-code/k3', 'gpt-5-codex').
 */
export interface CanonicalModelIdentity {
    /** Claude family when recognized, else undefined. */
    family?: string;
    /** Dotted version when present, e.g. '4.6'. */
    version?: string;
    /** Lowercased, punctuation-collapsed literal — the fallback compare key. */
    literal: string;
}

/** Lowercase, collapse punctuation/whitespace runs to single spaces, trim. */
function normalizeLiteral(model: string): string {
    return model
        .toLowerCase()
        .replace(/[_/\\().,]+/g, ' ')
        .replace(/-+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Modifier words that describe a mode or vendor, not the model identity.
 * `Claude Opus 4.6 (Thinking)` and `claude-opus-4-6` are the same model for slot
 * purposes — the thinking axis is carried separately by thinkingLevel.
 */
const MODIFIER_WORDS = new Set(['thinking', 'latest', 'preview', 'claude', 'anthropic']);

/** Parse any surface form of a model name into a canonical identity. */
export function canonicalizeModelName(model: string | undefined | null): CanonicalModelIdentity | undefined {
    if (typeof model !== 'string') return undefined;
    const literal = normalizeLiteral(model);
    if (!literal) return undefined;

    const tokens = literal.split(' ').filter(t => t && !MODIFIER_WORDS.has(t));
    const family = CLAUDE_FAMILIES.find(f => tokens.includes(f));

    let version: string | undefined;
    if (family) {
        // Version digits may be dotted ('4.6') or dash-separated ('4-6', which
        // normalizes to the tokens '4','6'). Prefer digit tokens after the family.
        const after = tokens.slice(tokens.indexOf(family) + 1).filter(t => /^\d+$/.test(t));
        if (after.length) version = after.join('.');
        else {
            const dotted = tokens.find(t => /^\d+(\.\d+)+$/.test(t));
            if (dotted) version = dotted;
        }
    }
    return { family, version, literal };
}

/**
 * True when two model names denote the same model.
 *
 * Claude models compare on canonical family+version. A version present on only
 * one side is treated as compatible with an unversioned name of the same family:
 * the preset alias `opus` is deliberately version-less and means "the opus this
 * slot provides", so `opus` matches `Claude Opus 4.6 (Thinking)`. Two DIFFERENT
 * explicit versions do not match.
 *
 * Non-Claude models compare on the normalized literal.
 */
export function modelNamesEquivalent(a: string | undefined | null, b: string | undefined | null): boolean {
    const ca = canonicalizeModelName(a);
    const cb = canonicalizeModelName(b);
    if (!ca || !cb) return false;
    if (ca.family && cb.family) {
        if (ca.family !== cb.family) return false;
        if (ca.version && cb.version) return ca.version === cb.version;
        return true; // one side is the version-less alias → same family is enough
    }
    // One side Claude and the other not → different models.
    if (ca.family || cb.family) return false;
    return ca.literal === cb.literal;
}

/**
 * Does `model` conform to what `slot` declares?
 *
 * A slot with NO model constrains only the provider — the provider's own default
 * is what the operator asked for, so any concrete model is undeclared and only
 * "no model" conforms. This mirrors how resolveUsableProvider already treats a
 * model-less slot: it returns no model at all rather than a wildcard.
 */
export function isModelAllowedBySlot(
    model: string | undefined | null,
    slot: NodeCapabilitySlot | undefined | null,
): boolean {
    if (!slot) return true;                       // nothing declared → nothing to enforce
    const declared = typeof slot.model === 'string' ? slot.model.trim() : '';
    const requested = typeof model === 'string' ? model.trim() : '';
    if (!declared) return !requested;             // model-less slot → provider default only
    if (!requested) return true;                  // no requested model → slot's own model applies
    return modelNamesEquivalent(requested, declared);
}

/** Skip reason emitted when a matching slot exists but is at its maxParallel cap. */
export const SLOT_MODEL_BUSY_SKIP_REASON = 'slot_for_model_busy';
/** Skip reason emitted when NO slot on the node can run the requested model. */
export const SLOT_MODEL_ABSENT_SKIP_REASON = 'no_slot_declares_requested_model';

export interface SlotAvailability {
    /** The slot itself. */
    slot: NodeCapabilitySlot;
    /**
     * True when this slot currently has capacity. A slot with no maxParallel is
     * uncapped and therefore always available.
     */
    available: boolean;
}

export interface SlotModelDecisionInput {
    /** Model the task wants to run with (preset-resolved or explicit). */
    requestedModel: string | undefined;
    /**
     * Every slot on the node, each paired with whether it currently has capacity.
     * Capacity is computed by the caller, which owns the live assignment counts.
     */
    slots: SlotAvailability[];
}

export type SlotModelDecision =
    /** A slot declaring this model has capacity now → launch on it. */
    | { outcome: 'run'; slot: NodeCapabilitySlot; model: string | undefined }
    /**
     * A slot declaring this model EXISTS but every such slot is at its cap.
     * Transient: the task stays queued and runs when the slot frees up. The
     * coordinator is deliberately NOT paged — this is the queue working.
     */
    | { outcome: 'wait'; reason: typeof SLOT_MODEL_BUSY_SKIP_REASON; busySlots: NodeCapabilitySlot[] }
    /**
     * NO slot on the node declares this model. Permanent: waiting can never
     * help, so the coordinator must be notified to re-drive the task some other
     * way (adjust difficulty, target another node, ask the owner).
     */
    | { outcome: 'notify'; reason: typeof SLOT_MODEL_ABSENT_SKIP_REASON; declaredModels: string[] };

/**
 * Decide what to do with a task whose requested model must be honored by one of
 * the node's declared slots.
 *
 * Owner-specified behaviour — three branches, and 'busy' vs 'absent' must never
 * collapse into one path:
 *
 *   1. a declaring slot has capacity   → run on it
 *   2. a declaring slot exists, all busy → WAIT in the queue (transient; no page).
 *      "That's the queue doing its job" — the task stays pending and claims the
 *      slot once it goes idle.
 *   3. no declaring slot at all         → NOTIFY the coordinator (permanent).
 *      Silently pending forever is the worst outcome; the coordinator needs to
 *      re-drive the task another way.
 *
 * Substitution is explicitly NOT an option: quietly downgrading to a model the
 * user did not choose violates the same invariant as running an undeclared one.
 */
export function decideSlotForModel(input: SlotModelDecisionInput): SlotModelDecision {
    const { requestedModel, slots } = input;
    const declaring = slots.filter(s => isModelAllowedBySlot(requestedModel, s.slot));

    if (!declaring.length) {
        const declaredModels = slots
            .map(s => (typeof s.slot.model === 'string' && s.slot.model.trim()) ? s.slot.model.trim() : '(provider default)')
            .filter((v, i, a) => a.indexOf(v) === i);
        return { outcome: 'notify', reason: SLOT_MODEL_ABSENT_SKIP_REASON, declaredModels };
    }

    const free = declaring.find(s => s.available);
    if (free) {
        // Launch with the slot's own declared model when it has one; a model-less
        // slot means "the provider's default", so pass no model at all.
        const declared = (typeof free.slot.model === 'string' && free.slot.model.trim())
            ? free.slot.model.trim()
            : undefined;
        return { outcome: 'run', slot: free.slot, model: declared };
    }

    return {
        outcome: 'wait',
        reason: SLOT_MODEL_BUSY_SKIP_REASON,
        busySlots: declaring.map(s => s.slot),
    };
}
