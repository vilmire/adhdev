/**
 * mesh ledger entry → `mesh.<id>.events` record projection (Phase 2 Stage 2).
 *
 * This is the ALLOW-LIST that makes a mesh ledger entry safe to replicate, and
 * it is the single most important file in the dual-write. Read the reasoning
 * before changing a line of it.
 *
 * ── Why a projection exists at all ─────────────────────────────────────────
 * The integration plan (§3) says "JSONL 기존 유지 + seqscribe 병행 기록", which
 * reads like a verbatim copy. A verbatim copy would be a content leak, because
 * two facts collide:
 *
 *   1. `MeshLedgerEntry.payload` is `Record<string, unknown>` and genuinely
 *      carries AGENT- AND USER-AUTHORED FREE TEXT. Not hypothetically — today:
 *        · `task_completed`   → `payload.finalSummary` (the worker's prose)
 *        · `coordinator_operating_note` → `payload.text` (the lesson text)
 *        · `task_question_pending` → the full InteractivePrompt, questions and
 *          option labels included
 *        · `dispatch_failed` → `payload.error` (an arbitrary error string)
 *      …and 68 call sites across 33 files may add more at any time.
 *
 *   2. `mesh.<id>.events` is **`access: 'metadata'` ON PURPOSE** (topics.ts).
 *      That class exists precisely so a cloud Durable Object peer may hold the
 *      topic and relay vectors (design §7). Metadata class is the one class a
 *      cloud relay may carry — which makes it exactly the wrong place for
 *      chat content, and puts it squarely under the CLAUDE.md server content
 *      boundary even though no `status_report` is involved.
 *
 * So the dual-write does what `buildCloudStatusReportPayload` does on the
 * status path: it PROJECTS DOWN to a fixed envelope of identifiers, enums,
 * booleans and counters before anything leaves the machine. Same discipline,
 * same reason, different transport.
 *
 * ── This is an allow-list, and it must stay one ────────────────────────────
 * ★ Never rewrite this as a deny-list (`delete payload.finalSummary`, an
 * `Omit<>`, a regex over key names). A deny-list silently ships every field a
 * future caller adds upstream — which is the exact failure mode CLAUDE.md
 * calls out for the four status-path layers. Fields are copied by NAME here,
 * or they do not travel.
 *
 * Adding a field to `PROJECTED_PAYLOAD_KEYS` is an assertion that it is
 * non-content: an identifier, an enum, a boolean, or a counter. Never free
 * text authored by a user or an agent. `assertNonContentValue` enforces the
 * shape at runtime (bounded strings, no nested objects), but it cannot know
 * that a short string is an id rather than a chat message — that judgement is
 * made here, at review time, per key.
 *
 * ── What is deliberately NOT projected ─────────────────────────────────────
 * The mesh ledger stays the system of record for the full entry. This topic
 * carries the SHAPE of mesh activity (what kind of thing happened, to which
 * task, on which node), never its prose. A consumer that needs the prose reads
 * the local ledger — which is where Stage 4's cutover has to keep it, and why
 * the cutover is a separate decision rather than a consequence of this file.
 */

import { estimateEntryBytes, resolveConstants, sanitizeJson, type JsonValue } from 'seqscribe';

/**
 * Entry `kind` used for every projected mesh ledger record.
 *
 * One kind rather than one-per-`MeshLedgerKind` because `kind` is part of no
 * schema hash on an `append` topic, but a stable, greppable namespace is worth
 * more than 40 near-identical names — the original ledger kind travels inside
 * the payload as `ledgerKind`, where a consumer can switch on it.
 */
export const MESH_EVENT_ENTRY_KIND = 'adhdev.mesh.ledger';

/**
 * Maximum length of any projected string.
 *
 * Every key below is an identifier or an enum, all of which are far shorter
 * than this in practice. The cap is a BACKSTOP against a caller stuffing prose
 * into a field whose name says identifier (a `reason` that grows into a
 * paragraph, a `nodeLabel` set to a sentence) — a bound on the blast radius,
 * not a substitute for the per-key judgement above.
 */
export const MAX_PROJECTED_STRING = 200;

/**
 * Payload keys copied into the replicated record.
 *
 * Each entry is a per-key assertion of "this is non-content". Reviewed
 * 2026-08-27 against every `appendLedgerEntry` call site:
 *
 *   ids       — taskId/deliveryId/attemptId/missionId/... : opaque handles
 *   routing   — nodeId/sessionId/providerType/transport   : addressing enums
 *   outcomes  — reason/status/outcome/terminalKind        : CLOSED enum sets
 *                 (`reason` is `MeshClaimRefusalReason` and friends — one of a
 *                  fixed set of slugs, never an operator-authored sentence;
 *                  the length cap backstops a caller who forgets that)
 *   booleans  — retryable/rebound/forced/membershipRemoved/...
 *   counters  — attempt counts and the like
 *
 * ★ NOT here, and never to be added: finalSummary, text, error, message,
 * summary, prompt, questions, workerResult, evidence, note, title, label
 * bodies — anything a human or an agent composed.
 */
export const PROJECTED_PAYLOAD_KEYS: readonly string[] = [
    // Identifiers
    'taskId',
    'deliveryId',
    'attemptId',
    'missionId',
    'checkpointId',
    'promptId',
    'providerSessionId',
    'targetNoteId',
    // Routing / addressing
    'nodeId',
    'sessionId',
    'providerType',
    'transport',
    'attemptedSessionId',
    'holderSessionId',
    // Outcome enums
    'reason',
    'status',
    'outcome',
    'terminalKind',
    'event',
    // Booleans
    'retryable',
    'rebound',
    'forced',
    'fallback',
    'membershipRemoved',
    'requestedForce',
    'removedByRemoteDaemon',
    'completedViaReady',
    // Counters
    'attempt',
    'attemptCount',
    'count',
] as const;

const PROJECTED_KEY_SET = new Set(PROJECTED_PAYLOAD_KEYS);

/**
 * The replicated record. Base fields mirror the ledger's own indexed columns
 * (which are identifiers by construction); `payload` is the projected subset.
 *
 * `id` and `timestamp` come from the ledger entry so a parity check can join
 * the two stores on a stable key without re-deriving one — see parity.ts.
 */
export interface ProjectedMeshEvent {
    /** The ledger entry's own uuid — the parity comparison key. */
    id: string;
    /** ISO timestamp, copied verbatim from the ledger entry. */
    timestamp: string;
    /** The original `MeshLedgerKind`. */
    ledgerKind: string;
    nodeId: string | null;
    sessionId: string | null;
    providerType: string | null;
    taskId: string | null;
    /** Allow-listed payload subset. Absent keys are simply not present. */
    payload: Record<string, string | number | boolean>;
}

/**
 * True when a value may cross as-is: a bounded string, a finite number, or a
 * boolean. Objects and arrays are refused wholesale rather than walked — a
 * nested structure is exactly how prose re-enters through a key that looked
 * scalar (`workerResult`, `evidence`, `questions` are all objects today).
 */
function isProjectableScalar(value: unknown): value is string | number | boolean {
    if (typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.length <= MAX_PROJECTED_STRING;
    return false;
}

/** Copy a base field, normalizing empty/absent to null. */
function baseField(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length <= MAX_PROJECTED_STRING ? trimmed : trimmed.slice(0, MAX_PROJECTED_STRING);
}

/**
 * Project a mesh ledger entry down to its replicable envelope.
 *
 * Total: every entry projects to something. A kind this file has never heard
 * of still yields its base fields, because the base fields are identifiers by
 * construction and dropping unknown kinds would make the replicated log
 * silently incomplete — worse than a shape-only record.
 */
export function projectMeshLedgerEntry(entry: {
    id: string;
    timestamp: string;
    kind: string;
    nodeId?: string | undefined;
    sessionId?: string | undefined;
    providerType?: string | undefined;
    taskId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
}): ProjectedMeshEvent {
    const payload: Record<string, string | number | boolean> = {};
    const source = entry.payload;
    if (source) {
        for (const key of PROJECTED_PAYLOAD_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
            const value = source[key];
            if (isProjectableScalar(value)) payload[key] = value;
        }
    }

    return {
        id: entry.id,
        timestamp: entry.timestamp,
        ledgerKind: entry.kind,
        nodeId: baseField(entry.nodeId),
        sessionId: baseField(entry.sessionId),
        providerType: baseField(entry.providerType),
        taskId: baseField(entry.taskId),
        payload,
    };
}

/**
 * Narrow a projected record to the library's `JsonValue` for `append`.
 *
 * ── Why `sanitizeJson` and not a cast (seqscribe v3.5 P12) ─────────────────
 * This used to be `event as unknown as JsonValue` — a compile-time assertion
 * that checked nothing at runtime. `ProjectedMeshEvent` is structurally a
 * `JsonValue` only as long as every producer honours the type, and the payload
 * map is built from `Record<string, unknown>` input, so the cast was trusting a
 * boundary the projection exists precisely to distrust. `sanitizeJson` walks
 * the tree, drops explicit-`undefined` properties into a FRESH object (it never
 * mutates ours), and throws `ERR_ENTRY_ENCODING` on anything `assertJsonValue`
 * would reject — turning a latent `append` rejection into a checked conversion.
 *
 * ★ Its one throwing case — an `undefined` ARRAY element, which cannot be
 * dropped because §4 makes positions load-bearing — is UNREACHABLE here, and
 * that is a property of the allow-list rather than luck: `isProjectableScalar`
 * refuses arrays and objects wholesale, so a projected `payload` holds only
 * strings, finite numbers and booleans, and the base fields are `string | null`.
 * No array ever reaches this function. Verified against the projection's own
 * behaviour, not assumed — see the P12 case in the boundary regression test.
 * If a future field ever admits an array, that assertion fails loudly rather
 * than silently shifting positions.
 */
export function toJsonValue(event: ProjectedMeshEvent): JsonValue {
    return sanitizeJson(event);
}

/**
 * Estimated wire size of the entry `recordMeshEventShadow` is about to append,
 * in bytes (seqscribe v3.5 P13).
 *
 * The projection bounds each string at `MAX_PROJECTED_STRING` and the key set
 * is fixed, so a projected entry is small by construction — this is a BACKSTOP
 * that makes "too large to append" knowable BEFORE the append rather than as an
 * `ERR_ENTRY_TOO_LARGE` rejection counted as a generic shadow failure.
 *
 * `estimateEntryBytes` is called WITHOUT a ctx, which yields the library's
 * monotone conservative upper bound (max-length writer, 16-digit numeric
 * fields). That is the right side to err on for a pre-flight check: the real
 * entry is never larger than the estimate, so a passing estimate cannot be
 * followed by a size rejection. `assertEntrySize` at commit stays authoritative.
 */
export function estimateProjectedEntryBytes(topic: string, event: ProjectedMeshEvent): number {
    return estimateEntryBytes({
        topic,
        kind: MESH_EVENT_ENTRY_KIND,
        payload: toJsonValue(event),
    });
}

/** The library's configured entry-size ceiling, for comparison with the above. */
export function maxEntryBytes(): number {
    return resolveConstants().MAX_ENTRY_BYTES;
}

/**
 * True when `key` is allow-listed. Exported for the boundary regression test,
 * which asserts a known content key (`finalSummary`, `text`) is NOT in the set
 * — the test fails loudly if someone widens the list to include one.
 */
export function isProjectedPayloadKey(key: string): boolean {
    return PROJECTED_KEY_SET.has(key);
}
