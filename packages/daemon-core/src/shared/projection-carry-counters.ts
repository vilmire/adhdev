/**
 * (G1) Runtime field-loss counters for the chat-message projection path.
 *
 * ── What gap this closes ───────────────────────────────────────────────────
 * `check:message-projection-parity` is a SOURCE guard: it proves every marked
 * hop still mentions each carried field. That is a strong check against the
 * failure it was built for — an accidental drop during an unrelated edit — but
 * it is blind to everything that happens at runtime. A field can be named at
 * every hop and still not arrive, because the hop before it never produced one:
 * a provider that stops minting `sequence`, a parser path that yields bubbles
 * with no `_turnKey`, a truncation that leaves `toolBlockRef` unset. The source
 * gate reads those as healthy, because textually they are.
 *
 * So the gate answers "is every hop still wired" and these counters answer "is
 * anything actually flowing through the wiring". Neither substitutes for the
 * other, and the pair is what makes a silent identity loss diagnosable from a
 * live daemon instead of only from a bug report about duplicated bubbles.
 *
 * ── Where it is measured ───────────────────────────────────────────────────
 * At the shared carry helpers (`carryBubbleIdentity` / `carryMessageRefs`,
 * providers/cli-provider-history-dedup.ts), which every delegating L3 hop
 * funnels through. One instrumentation point rather than eight keeps the hot
 * path cheap and cannot drift out of sync with the projection sites the way a
 * per-site counter would.
 *
 * ── Why this file lives in shared/ ─────────────────────────────────────────
 * It is WRITTEN from providers/ and READ from seqscribe/ (stats.ts, for
 * `get_status_metadata`), and `check:import-boundaries` forbids seqscribe/**
 * from importing providers/**. As a dependency-free leaf it belongs in neither
 * layer — the same reason `mesh-event-trace.ts` and `usage-normalize.ts` were
 * moved here. Do not move it back under providers/.
 *
 * ── ★ Content boundary (CLAUDE.md "Server content boundary") ───────────────
 * LOCAL-ONLY, and structurally incapable of carrying content: the entire state
 * is five integers keyed by FIXED field names declared in this file. No message
 * text, no session id, no provider name, no topic name — the counters cannot
 * express any of those, because nothing but a fixed-key increment is ever
 * recorded.
 *
 * These are raw monotonic counters, so they must NEVER be added to the status
 * report even if a future reader wants them: `sendUnifiedStatusReport` dedups
 * server frames by hashing the payload, and a live counter would change every
 * tick and turn an idle daemon into a constant transmitter — the same reason
 * `readRouting` and `transcriptParityDetail` are local-only in seqscribe/
 * stats.ts. They are exposed through `get_status_metadata` and the daemon log,
 * which are local surfaces.
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 * This is a per-message hot path, so the measurement is a handful of `typeof`
 * checks and integer increments on a module-level object — no allocation, no
 * clock read, no string building, and no work proportional to content length.
 * It is unconditional rather than flag-gated because a counter you have to
 * enable before reproducing is a counter that is never on when the defect
 * happens, which is precisely the situation this exists to fix.
 */

/**
 * The carried fields, by name. Fixed set — a counter key can never be anything
 * but one of these, which is what makes the shape content-free by construction.
 */
export interface ProjectionCarryCounters {
    /** Messages that passed through a carry helper. The denominator. */
    observed: number;
    /** Messages that arrived WITHOUT a usable `sequence`. */
    missingSequence: number;
    /** Messages that arrived without `_turnKey`. */
    missingTurnKey: number;
    /** Messages that arrived without `bubbleState`. */
    missingBubbleState: number;
    /**
     * Messages carrying NO per-bubble identity at all — neither `bubbleId`,
     * `providerUnitKey`, nor a numeric `sequence`.
     *
     * ★ This is the load-bearing one. The other counters are per-field and a
     * nonzero value on any single one is often benign (not every bubble has a
     * tool ref; a provider may legitimately not mint `_turnKey`). This one is
     * the composite the dashboard's React key actually needs: when it is
     * nonzero, `getChatMessageStableKey` has fallen through to the content-hash
     * fallback, and every bubble of a turn that shares its text collides on one
     * key. That is the duplicated/vanishing-bubble defect, counted at its cause
     * instead of inferred from its symptom.
     */
    missingBubbleIdentity: number;
    /**
     * Messages whose `toolBlockRef` was dropped BY THE HELPER — i.e. the field
     * was present on the input but not carried out.
     *
     * ★ Counted as a drop only in that case, never merely because the input had
     * no ref. Most messages legitimately have none (only truncated tool blocks
     * do), so counting absence would make this field noise. A nonzero value
     * here means the carry itself failed, which is always a defect.
     */
    droppedToolBlockRef: number;
}

const counters: ProjectionCarryCounters = {
    observed: 0,
    missingSequence: 0,
    missingTurnKey: 0,
    missingBubbleState: 0,
    missingBubbleIdentity: 0,
    droppedToolBlockRef: 0,
};

/**
 * Record one message's carry outcome. Called from the shared carry helpers.
 *
 * `input` is the message as it arrived; `carriedToolBlockRef` says whether the
 * helper emitted a ref, so the drop case can be distinguished from the (normal)
 * no-ref case without re-reading the output object.
 */
export function recordProjectionCarry(
    input: {
        sequence?: unknown;
        _turnKey?: unknown;
        bubbleState?: unknown;
        providerUnitKey?: unknown;
        bubbleId?: unknown;
        toolBlockRef?: unknown;
    } | null | undefined,
    carriedToolBlockRef: boolean,
): void {
    counters.observed += 1;
    if (!input) {
        counters.missingSequence += 1;
        counters.missingTurnKey += 1;
        counters.missingBubbleState += 1;
        counters.missingBubbleIdentity += 1;
        return;
    }
    // Mirrors the helper's own acceptance test exactly — a `sequence` the helper
    // would refuse to carry must count as missing here, or the counter would
    // report health the projection does not actually have.
    const hasSequence = typeof input.sequence === 'number' && Number.isFinite(input.sequence);
    if (!hasSequence) counters.missingSequence += 1;
    if (!input._turnKey) counters.missingTurnKey += 1;
    if (!input.bubbleState) counters.missingBubbleState += 1;
    if (!input.bubbleId && !input.providerUnitKey && !hasSequence) {
        counters.missingBubbleIdentity += 1;
    }
    if (input.toolBlockRef && !carriedToolBlockRef) counters.droppedToolBlockRef += 1;
}

/** A copy of the counters, so a caller cannot observe later mutation. */
export function projectionCarryCounters(): ProjectionCarryCounters {
    return { ...counters };
}

/** Test-only reset. Not called in production. */
export function resetProjectionCarryCounters(): void {
    counters.observed = 0;
    counters.missingSequence = 0;
    counters.missingTurnKey = 0;
    counters.missingBubbleState = 0;
    counters.missingBubbleIdentity = 0;
    counters.droppedToolBlockRef = 0;
}
