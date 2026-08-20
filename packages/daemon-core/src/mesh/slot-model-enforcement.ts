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
 * PROVIDER PAIRING (`providerType`): the decision returns a `(slot, model)` PAIR,
 * and the caller must spawn both halves of it. When the caller has already picked
 * the provider it will spawn, it MUST pass `providerType` so only that provider's
 * slots compete. The original signature had no such parameter, and the assignment
 * path — which resolves the provider first, then called this with EVERY slot on
 * the node — harvested only the model. A node holding claude-cli/opus therefore
 * returned `opus` for a grok-cli launch: a pair no operator declared, and the very
 * substitution the paragraph above forbids, arrived at by splitting the pair
 * rather than by choosing a different model. This is not a race; the two
 * resolutions are consecutive synchronous reads of the same node object, so a
 * `difficult` task on a node with a claude slot reproduced it every time.
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
    /**
     * PROVIDER PAIRING: when the caller has already selected the provider that
     * will actually be spawned, pass it here so only that provider's slots
     * compete. Omitting it considers every slot on the node, which is only
     * correct when the provider is not yet decided.
     *
     * WHY THIS IS NOT OPTIONAL AT THE ASSIGNMENT CALL SITE: this function
     * returns a `(slot, model)` pair, but the assignment path harvested only
     * `.model` from it and spawned with the SEPARATELY-resolved provider. With
     * no provider filter, a node holding a claude-cli/opus slot handed `opus`
     * back for a grok-cli launch — a provider/model pair the operator never
     * declared, and precisely the "substitute a different model" this module's
     * header says it rejects. The mismatch then poisoned the ledger's
     * resolvedModel and, downstream, silently voided the per-slot cap.
     */
    providerType?: string;
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
    // PROVIDER PAIRING: narrow to the provider that will actually be spawned
    // before anything else, so the model can only ever come from a slot that
    // provider declares. Without this the three branches below answered the
    // wrong question — "does ANY slot on the node declare this model?" — and a
    // foreign provider's slot could satisfy it, breaking the (provider, model)
    // pair. Narrowing also makes 'notify'/'wait' fire honestly: a model no slot
    // of THIS provider declares is a real absence, not something to be papered
    // over by borrowing a sibling provider's model.
    const wanted = typeof input.providerType === 'string' ? input.providerType.trim() : '';
    const candidates = wanted
        ? slots.filter(s => (s.slot.provider?.trim() ?? '') === wanted)
        : slots;
    const declaring = candidates.filter(s => isModelAllowedBySlot(requestedModel, s.slot));

    if (!declaring.length) {
        const declaredModels = candidates
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

/**
 * The launch-time slot finalization the assignment path needs, derived in one
 * place so the demotion bookkeeping cannot drift from the decision it describes.
 *
 * Extracted from the assignment loop rather than inlined there: it is pure
 * (slots + capacity in, verdict out), it is the natural home for the PROVIDER
 * PAIRING invariant documented above, and mesh-queue-assignment.ts is a frozen
 * file-size baseline that must be decomposed rather than grown.
 *
 * `demoted` compares the WINNING slot (what provider selection chose) against
 * the FINALIZED slot (what the guard settled on). Both halves — provider and
 * model — are compared, because either can move independently.
 */
export interface SlotFinalization {
    /** Slot the guard settled on; both provider and model are launched from it. */
    slot: NodeCapabilitySlot;
    /** The finalized slot's own model, or undefined for a model-less slot. */
    model: string | undefined;
    /** True when the finalized slot differs from the winning slot in either half. */
    demoted: boolean;
    /**
     * Why the finalized slot differs. `slot_reselected_during_launch` when the
     * winning slot still had capacity (so the move was not forced by load);
     * `winning_slot_capacity_exhausted` when it did not.
     */
    demotionReason?: 'slot_reselected_during_launch' | 'winning_slot_capacity_exhausted';
}

export function finalizeSlotSelection(args: {
    /** The slot provider selection won on. */
    winningSlot: NodeCapabilitySlot | undefined;
    /** The slot the SLOT MODEL GUARD returned for a 'run' outcome. */
    decidedSlot: NodeCapabilitySlot;
    /** Model the guard returned alongside decidedSlot. */
    decidedModel: string | undefined;
    /** Whether the winning slot still has capacity — separates the two reasons. */
    winningSlotHasCapacity: boolean;
}): SlotFinalization {
    const winningModel = args.winningSlot?.model?.trim() || undefined;
    const finalizedModel = args.decidedSlot.model?.trim() || undefined;
    const demoted = args.winningSlot?.provider !== args.decidedSlot.provider
        || winningModel !== finalizedModel;
    return {
        slot: args.decidedSlot,
        model: args.decidedModel,
        demoted,
        ...(demoted
            ? {
                demotionReason: args.winningSlotHasCapacity
                    ? 'slot_reselected_during_launch' as const
                    : 'winning_slot_capacity_exhausted' as const,
            }
            : {}),
    };
}
