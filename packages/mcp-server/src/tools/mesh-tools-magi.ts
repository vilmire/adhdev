// Mesh tool implementations — MAGI (Multi-Agent Ground-truth Insight) domain.
//
// A standing mesh cross-verification quorum for any read-only investigation:
// fan the SAME question out to N independent (node × provider) replicas, then
// synthesize consensus / disagreement / unique evidence into a needs_verification
// list — NOT a majority vote (high agreement among coupled agents ≠ correct).
//
// Design: docs/design/2026-06-28-mesh-magi-review.md.
//
// The pure core (parseMagiResponse / synthesizeMagiResponses / buildMagiFanoutPlan)
// is unit-tested in mesh-tools-magi.test.ts; the handlers wire it to the mesh
// queue/mission/transport. Shared helpers and dependency re-exports live in
// ./mesh-tools-internal.ts; mesh-tools.ts is the barrel.

import {
    annotateQueueStaleness,
    appendLedgerEntry,
    buildMeshNodeCapabilityTags,
    commandForNode,
    compactChatPayload,
    enqueueTask,
    findOptionalNodeWithRefresh,
    getMeshMission,
    getQueue,
    isWeakCompletionEvidence,
    isMeshNodeHealthLaunchable,
    resolveEffectiveMeshNodeHealth,
    getMagiKindPanel,
    listMagiKindPanels,
    setMagiKindPanel,
    normalizeMagiSlots,
    collectIgnoredMagiSlotFields,
    MAGI_RAW_ANSWER_CAP,
    meshNodeIdMatches,
    nodeSatisfiesRequiredTags,
    normalizeMeshCapabilityTags,
    randomUUID,
    readProviderPriority,
    readLedgerEntries,
    readString,
    refreshMeshFromDaemon,
    resolveCoordinatorNode,
    resolveSemanticReplicaTransport,
    triggerMeshQueueAndReport,
    unwrapCommandPayload,
    upsertMeshMission,
} from './mesh-tools-internal.js';
import { readTranscriptReplicaForSemanticConsumer } from './mesh-transcript-semantic-read.js';
import { resolveMagiSessionCleanupMode, type RepoMeshMagiSessionCleanupMode } from '@adhdev/daemon-core';
import type {
    LocalMeshEntry,
    LocalMeshNodeEntry,
    MagiAgentResponse,
    MagiClaim,
    MagiClaimCluster,
    MagiClusterMember,
    MagiGitSkew,
    MagiMode,
    MagiTaskKind,
    MagiSlot,
    MagiReplicaGitRef,
    MagiResponseSource,
    MagiSynthesis,
    MagiSynthesizedResponse,
    MeshContext,
} from './mesh-tools-internal.js';

// ─── Guards / constants ─────────────────────────

/** Hard cap on total replicas (members × n) per mesh_magi_review invocation. */
export const MAGI_MAX_REPLICAS = 12;
/** Minimum distinct (node, provider) targets a panel must resolve to. */
const MAGI_MIN_TARGETS = 2;
/**
 * Lexical-cluster merge threshold (Jaccard over claim token sets).
 * FIX#2c: relaxed 0.5 → 0.4 so cross-provider same-conclusion claims worded a little
 * differently still merge (they were each becoming distinctProviders=1 singletons). Kept
 * conservative — the existing synthesis unit tests (singleton non-merge etc.) still pass at
 * 0.4 because their non-mergeable claims share zero content tokens (jaccard 0).
 */
const MAGI_CLUSTER_JACCARD = 0.4;
/**
 * Default wall-clock budget for wait=true replica collection.
 *
 * MAGI-DEADLINE-MISLABEL: was 180_000 (3 min). A live 3-replica fan-out measured
 * kimi taking 16m09s (claim → completed) to produce a fully-evidenced answer — the
 * 180s deadline force-finalized it as `unparseable_output` 13 minutes before it
 * actually answered, which the coordinator then read as "kimi failed to produce
 * valid output" instead of "kimi hadn't answered yet". Raised to 480_000 (8 min) —
 * comfortably past typical replica latency without making every `wait:true` review
 * block the coordinator for a long time by default. Not differentiated per
 * task_kind (rca/design/freeform): the one measured overrun was an `rca` replica,
 * and a per-kind budget would need its own config surface for a single data point —
 * not worth the complexity. A review that may run long should prefer `wait:false` +
 * `mesh_magi_collect` (async collection, no coordinator block) over raising this
 * further; `wait_timeout_ms` can still override up to MAGI_MAX_WAIT_MS per call.
 */
export const MAGI_DEFAULT_WAIT_MS = 480_000;
/**
 * Hard ceiling on wait_timeout_ms (both the default above and any caller override).
 * Raised 600_000 (10 min) → 1_200_000 (20 min) alongside the default bump so a
 * caller that explicitly wants to block past the new default (e.g. to cover the
 * measured 16m09s kimi case synchronously) has headroom to do so; the async
 * wait:false + mesh_magi_collect path remains the recommended way to avoid
 * blocking the coordinator at all.
 */
export const MAGI_MAX_WAIT_MS = 1_200_000;
const MAGI_POLL_INTERVAL_MS = 5_000;

/**
 * Pure clamp applied to a caller-supplied wait_timeout_ms (mesh_magi_review /
 * mesh_magi_collect): falls back to MAGI_DEFAULT_WAIT_MS when absent/non-numeric/zero,
 * then bounds the result to [MAGI_POLL_INTERVAL_MS, MAGI_MAX_WAIT_MS]. Extracted so the
 * exact arithmetic both call sites share is independently unit-testable without waiting
 * out real (or mocked) minutes-long timers.
 */
export function resolveMagiWaitTimeoutMs(raw: unknown): number {
    return Math.min(MAGI_MAX_WAIT_MS, Math.max(MAGI_POLL_INTERVAL_MS, Number(raw) || MAGI_DEFAULT_WAIT_MS));
}

// ─── Task kinds (MAGI-REDESIGN) ─────────────────
//
// A `task_kind` selects ONE output schema that is injected into the replica prompt
// (no schema-on-schema conflict) and ONE strict parser used at collection. The
// kinds are: claim_audit (default, backward-compatible), rca, design, freeform.
// Every kind except freeform requires non-empty evidence[]; an empty-evidence
// answer is a validation failure that triggers the single delta re-request (E).
//
// To avoid rewriting the diversity-weighted synthesis (which is defined over the
// common-schema MagiAgentResponse — claims/top_findings/open_questions), each kind
// ADAPTS its typed payload into a MagiAgentResponse so clustering/independence still
// work, while the raw typed payload is preserved on the source for display.

// MagiTaskKind SSOT lives in the mesh-shared leaf, consumed here through daemon-core's
// re-export (mesh-tools-internal) — same indirection as the other Magi* types, so this
// module takes no direct @adhdev/mesh-shared dependency. Re-exported for existing
// callers that import MagiTaskKind from this module.
export type { MagiTaskKind } from './mesh-tools-internal.js';

const VALID_TASK_KINDS: readonly MagiTaskKind[] = ['claim_audit', 'rca', 'design', 'freeform'];
const DEFAULT_TASK_KIND: MagiTaskKind = 'claim_audit';

// ─── MAGI-KIND-PANEL ───
//
// A bare `task_kind` (no pre-authored panel name / members) NO LONGER auto-synthesizes
// a diverse cross-provider panel from the live mesh. It resolves the user's explicitly
// configured kind-panel binding (magiKindPanels: task_kind → (node × provider × model?)
// slots). An unconfigured kind is a hard error (magi_kind_not_configured), never a
// synthetic fallback. The former MAGI_KIND_PRESETS intent table and its resolver
// (buildPresetMagiPanelForKind + helpers) were removed with that behavior change.

export function normalizeMagiTaskKind(raw: unknown): MagiTaskKind {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return (VALID_TASK_KINDS as readonly string[]).includes(s) ? (s as MagiTaskKind) : DEFAULT_TASK_KIND;
}

/** Parsed rca payload (kind=rca). */
export interface MagiRcaResponse {
    rootCause: string;
    failsAt: string;
    mechanism: string;
    evidence: string[];
    fixDirection: string;
    confidence: number;
}

/** Parsed design payload (kind=design). */
export interface MagiDesignResponse {
    recommendation: string;
    rationale: string;
    alternatives: string[];
    tradeoffs: string[];
    risks: string[];
    evidence: string[];
    confidence: number;
}

/** Parsed freeform payload (kind=freeform) — unstructured natural-language answer. */
export interface MagiFreeformResponse {
    text: string;
}

/**
 * Result of a kind-aware parse: the common-schema response fed to synthesis, the
 * raw typed payload for display, and (on failure) a structured reason that drives
 * the single delta re-request. `ok=false` means the text could not be coerced into
 * a valid response for this kind (missing required fields / empty evidence / no JSON).
 */
export interface MagiKindParseResult {
    ok: boolean;
    /** Adapted common-schema response for synthesis (present when ok). */
    response?: MagiAgentResponse;
    /** Raw typed payload (rca/design/freeform) for display (present when ok). */
    payload?: MagiRcaResponse | MagiDesignResponse | MagiFreeformResponse | MagiAgentResponse;
    /** Why the parse failed — surfaced and used to decide the delta re-request. */
    failReason?: 'no_parseable_output' | 'missing_required_fields' | 'empty_evidence';
}

const VALID_STANCES = new Set(['support', 'oppose', 'uncertain']);

function coerceClaim(raw: unknown): MagiClaim | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const claim = typeof r.claim === 'string' ? r.claim.trim() : '';
    if (!claim) return null;
    const stance = typeof r.stance === 'string' && VALID_STANCES.has(r.stance) ? r.stance as MagiClaim['stance'] : 'uncertain';
    const evidence = Array.isArray(r.evidence)
        ? r.evidence.map(e => typeof e === 'string' ? e.trim() : '').filter(Boolean)
        : [];
    const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence)
        ? Math.min(1, Math.max(0, r.confidence))
        : 0.5;
    return { claim, stance, evidence, confidence };
}

function coerceResponse(raw: unknown): MagiAgentResponse | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.claims)) return null;
    const claims = r.claims.map(coerceClaim).filter((c): c is MagiClaim => c !== null);
    const top_findings = Array.isArray(r.top_findings)
        ? r.top_findings.map(f => typeof f === 'string' ? f.trim() : '').filter(Boolean)
        : [];
    const open_questions = Array.isArray(r.open_questions)
        ? r.open_questions.map(q => typeof q === 'string' ? q.trim() : '').filter(Boolean)
        : [];
    // A response with no parseable claims is treated as unusable.
    if (claims.length === 0 && top_findings.length === 0) return null;
    return { claims, top_findings, open_questions };
}

/**
 * Scan text for balanced top-level JSON objects and return their substrings,
 * longest-first. Tolerates prose around the JSON and ```json fences — the agent
 * is asked for raw JSON but providers vary, so we extract defensively.
 */
function extractJsonObjectCandidates(text: string): string[] {
    const candidates: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}') {
            if (depth > 0) {
                depth--;
                if (depth === 0 && start >= 0) {
                    candidates.push(text.slice(start, i + 1));
                    start = -1;
                }
            }
        }
    }
    // Longest first: the full envelope object is preferred over a nested fragment.
    return candidates.sort((a, b) => b.length - a.length);
}

/**
 * Parse one agent's raw output text into the common-schema MagiAgentResponse, or
 * null when no parseable response is present. Pure — the unit of synthesis input.
 */
export function parseMagiResponse(text: string): MagiAgentResponse | null {
    if (typeof text !== 'string' || !text.trim()) return null;
    // Fast path: the whole text is the JSON object.
    const direct = ((): MagiAgentResponse | null => {
        try { return coerceResponse(JSON.parse(text)); } catch { return null; }
    })();
    if (direct) return direct;
    for (const candidate of extractJsonObjectCandidates(text)) {
        if (!candidate.includes('"claims"') && !candidate.includes('"top_findings"')) continue;
        try {
            const parsed = coerceResponse(JSON.parse(candidate));
            if (parsed) return parsed;
        } catch { /* try next candidate */ }
    }
    return null;
}

// ─── Kind-aware parsing (MAGI-REDESIGN C/D) ──────

function asStringArray(raw: unknown): string[] {
    return Array.isArray(raw)
        ? raw.map(e => typeof e === 'string' ? e.trim() : '').filter(Boolean)
        : [];
}

function asConfidence(raw: unknown): number {
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
}

function asTrimmedString(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Coerce a parsed JSON object into the rca payload. Returns the typed payload plus a
 * validity verdict separating "missing required fields" from "empty evidence" so the
 * caller can drive the delta re-request and surface the precise failure. rootCause +
 * mechanism are the minimum structural fields; evidence[] is the common D-rule field.
 */
function coerceRcaResponse(raw: unknown): { payload: MagiRcaResponse; failReason?: MagiKindParseResult['failReason'] } | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const rootCause = asTrimmedString(r.rootCause);
    const mechanism = asTrimmedString(r.mechanism);
    const failsAt = asTrimmedString(r.failsAt);
    const fixDirection = asTrimmedString(r.fixDirection);
    const evidence = asStringArray(r.evidence);
    const confidence = asConfidence(r.confidence);
    // Not an rca envelope at all (no structural field present) → let the caller try other shapes.
    if (!rootCause && !mechanism && !failsAt && !fixDirection && evidence.length === 0) return null;
    const payload: MagiRcaResponse = { rootCause, failsAt, mechanism, evidence, fixDirection, confidence };
    if (!rootCause || !mechanism) return { payload, failReason: 'missing_required_fields' };
    if (evidence.length === 0) return { payload, failReason: 'empty_evidence' };
    return { payload };
}

/**
 * Coerce a parsed JSON object into the design payload. recommendation + rationale are
 * the minimum structural fields; evidence[] is the common D-rule field.
 */
function coerceDesignResponse(raw: unknown): { payload: MagiDesignResponse; failReason?: MagiKindParseResult['failReason'] } | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const recommendation = asTrimmedString(r.recommendation);
    const rationale = asTrimmedString(r.rationale);
    const alternatives = asStringArray(r.alternatives);
    const tradeoffs = asStringArray(r.tradeoffs);
    const risks = asStringArray(r.risks);
    const evidence = asStringArray(r.evidence);
    const confidence = asConfidence(r.confidence);
    if (!recommendation && !rationale && alternatives.length === 0 && tradeoffs.length === 0 && risks.length === 0 && evidence.length === 0) return null;
    const payload: MagiDesignResponse = { recommendation, rationale, alternatives, tradeoffs, risks, evidence, confidence };
    if (!recommendation || !rationale) return { payload, failReason: 'missing_required_fields' };
    if (evidence.length === 0) return { payload, failReason: 'empty_evidence' };
    return { payload };
}

/**
 * Adapt an rca payload into the common-schema MagiAgentResponse so the existing
 * diversity-weighted synthesis (which clusters MagiClaim) applies unchanged: the root
 * cause becomes a single supporting claim carrying the rca evidence, mechanism/failsAt/
 * fixDirection become top_findings. Evidence is preserved verbatim so cross-replica
 * file:line independence still drives needs_verification.
 */
function rcaToCommonSchema(p: MagiRcaResponse): MagiAgentResponse {
    return {
        claims: [{ claim: p.rootCause, stance: 'support', evidence: p.evidence, confidence: p.confidence }],
        top_findings: [
            ...(p.failsAt ? [`fails at: ${p.failsAt}`] : []),
            ...(p.mechanism ? [`mechanism: ${p.mechanism}`] : []),
            ...(p.fixDirection ? [`fix direction: ${p.fixDirection}`] : []),
        ],
        open_questions: [],
    };
}

/**
 * Adapt a design payload into the common-schema MagiAgentResponse: the recommendation
 * becomes the supporting claim (evidence preserved), rationale/alternatives/tradeoffs
 * become top_findings, risks become open_questions (each risk is an unresolved concern).
 */
function designToCommonSchema(p: MagiDesignResponse): MagiAgentResponse {
    return {
        claims: [{ claim: p.recommendation, stance: 'support', evidence: p.evidence, confidence: p.confidence }],
        top_findings: [
            ...(p.rationale ? [`rationale: ${p.rationale}`] : []),
            ...p.alternatives.map(a => `alternative: ${a}`),
            ...p.tradeoffs.map(t => `tradeoff: ${t}`),
        ],
        open_questions: p.risks.map(r => `risk: ${r}`),
    };
}

/** Walk JSON candidates in text (raw object first, then embedded), applying a coercer. */
function firstJsonCandidate<T>(text: string, coerce: (raw: unknown) => T | null): T | null {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
        const direct = coerce(JSON.parse(text));
        if (direct) return direct;
    } catch { /* fall through to embedded extraction */ }
    for (const candidate of extractJsonObjectCandidates(text)) {
        try {
            const parsed = coerce(JSON.parse(candidate));
            if (parsed) return parsed;
        } catch { /* try next candidate */ }
    }
    return null;
}

/**
 * Kind-aware parse of one replica's raw output text. claim_audit reuses the legacy
 * common-schema parser (claims required). rca/design extract their typed envelope from
 * raw or embedded JSON (no claims array required — the claims-less envelopes that the
 * old parser dropped now parse). freeform never fails parsing — any non-empty text is a
 * valid answer with no schema/evidence requirement. Pure.
 *
 * Returns ok=false with a failReason (no JSON / missing fields / empty evidence) so the
 * collection path can fire the single delta re-request (E) and surface the reason.
 */
export function parseMagiResponseForKind(text: string, kind: MagiTaskKind): MagiKindParseResult {
    if (kind === 'freeform') {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) return { ok: false, failReason: 'no_parseable_output' };
        const payload: MagiFreeformResponse = { text: trimmed };
        // freeform contributes no structured claims to synthesis (cross-verify is weak).
        return { ok: true, response: { claims: [], top_findings: [trimmed], open_questions: [] }, payload };
    }
    if (kind === 'claim_audit') {
        const parsed = parseMagiResponse(text);
        if (!parsed) return { ok: false, failReason: 'no_parseable_output' };
        // D-rule: at least one claim must carry evidence (else it is unverifiable).
        const hasEvidence = parsed.claims.some(c => c.evidence.length > 0) || parsed.top_findings.length > 0;
        if (!hasEvidence && parsed.claims.length > 0) return { ok: false, payload: parsed, failReason: 'empty_evidence' };
        return { ok: true, response: parsed, payload: parsed };
    }
    if (kind === 'rca') {
        const result = firstJsonCandidate(text, coerceRcaResponse);
        if (!result) return { ok: false, failReason: 'no_parseable_output' };
        if (result.failReason) return { ok: false, payload: result.payload, failReason: result.failReason };
        return { ok: true, response: rcaToCommonSchema(result.payload), payload: result.payload };
    }
    // kind === 'design'
    const result = firstJsonCandidate(text, coerceDesignResponse);
    if (!result) return { ok: false, failReason: 'no_parseable_output' };
    if (result.failReason) return { ok: false, payload: result.payload, failReason: result.failReason };
    return { ok: true, response: designToCommonSchema(result.payload), payload: result.payload };
}

/** Parse the first kind-valid MAGI candidate from a daemon read_chat payload, newest-first. */
export function parseFirstMagiCandidateForKind(
    payload: unknown,
    kind: MagiTaskKind,
    opts: { sessionId?: string | null } = {},
): MagiKindParseResult {
    const rawCandidates = collectMagiCandidateTexts(payload);
    let compactCandidates: string[] = [];
    try {
        compactCandidates = collectMagiCandidateTexts(
            compactChatPayload(payload, { sessionId: opts.sessionId ?? null }),
        );
    } catch { /* compact lift is best-effort */ }
    const seen = new Set<string>();
    let lastFail: MagiKindParseResult = { ok: false, failReason: 'no_parseable_output' };
    for (const candidate of [...rawCandidates, ...compactCandidates]) {
        const trimmed = candidate.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        const result = parseMagiResponseForKind(candidate, kind);
        if (result.ok) return result;
        // Prefer the most specific failure (a parsed-but-invalid envelope over "no JSON")
        // so the surfaced reason / re-request is accurate.
        if (result.failReason !== 'no_parseable_output') lastFail = result;
    }
    return lastFail;
}

// ─── Synthesis (pure) ───────────────────────────

const CLAIM_STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
    'on', 'at', 'and', 'or', 'for', 'this', 'that', 'it', 'its', 'as', 'by', 'with',
]);

function claimTokenSet(claim: string): Set<string> {
    const tokens = claim.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !CLAIM_STOPWORDS.has(t));
    return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const t of a) if (b.has(t)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/** Looks like specific source evidence (file:line / path / URL), a strong merge signal. */
function isSpecificEvidence(ev: string): boolean {
    return /[\w/.\\-]+:\d+/.test(ev) || /[\w-]+\.[a-z]{1,5}\b/i.test(ev) || /https?:\/\//i.test(ev);
}

/**
 * FIX#2c — canonicalize a single concrete evidence TOKEN (file:line or URL) so the SAME
 * source merges across differently-FORMATTED citations. The greedy merge compares
 * specificEvidence sets by exact string membership, so two replicas that cite the same file
 * line as `resolver.ts:128` vs `src/resolver.ts:128` (or the same doc as a bare URL vs a
 * prose "see https://… (the design doc)") never merged and each stayed a distinctProviders=1
 * singleton. Canonicalize the recognizable concrete forms; everything else falls back to the
 * old lowercase-collapse. Pure / order-independent.
 *
 *  - file:line  → `<basename>:<line>` (drop directory prefix + normalize \\ vs / so the same
 *    file cited with/without a path prefix collides; the basename+line pair is the discriminator)
 *  - URL        → scheme-less host+path, lowercased, no trailing slash / query / fragment
 */
function canonicalizeSpecificEvidence(ev: string): string {
    const lower = ev.toLowerCase().replace(/\s+/g, ' ').trim();
    // URL: strip scheme, query, fragment, trailing slash so a bare URL and a prose-embedded
    // citation of the same URL canonicalize identically.
    const urlMatch = lower.match(/https?:\/\/([^\s)\]>"']+)/i);
    if (urlMatch) {
        const stripped = urlMatch[1].replace(/[#?].*$/, '').replace(/\/+$/, '');
        return `url:${stripped}`;
    }
    // file:line — take the LAST path segment (basename) + line number, separator-agnostic.
    const fileLine = lower.match(/([\w./\\-]+):(\d+)/);
    if (fileLine) {
        const pathPart = fileLine[1].replace(/\\/g, '/');
        const basename = pathPart.split('/').filter(Boolean).pop() || pathPart;
        return `${basename}:${fileLine[2]}`;
    }
    return lower;
}

function normalizeEvidence(ev: string): string {
    // For specific (file:line / URL) evidence, use the canonical form so cross-format
    // citations of the same source compare equal; otherwise plain lowercase-collapse.
    return isSpecificEvidence(ev) ? canonicalizeSpecificEvidence(ev) : ev.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface ClusterAccumulator {
    members: MagiClusterMember[];
    tokens: Set<string>;
    specificEvidence: Set<string>;
}

/**
 * Decide, from a replica's `read_chat` payload, whether it is wedged on an approval
 * prompt that MAGI collect should auto-approve. True when the live session reports an
 * approval/choice status OR carries an active modal — the states in which a readonly
 * MAGI replica sits blocked instead of producing its answer. Pure — unit-testable on
 * synthetic read_chat payloads. See nudgeWedgedReplica for why approving is safe here.
 */
export function magiReadIndicatesApprovalWedge(payload: unknown): boolean {
    const p = payload as { status?: unknown; activeModal?: unknown } | null | undefined;
    if (!p || typeof p !== 'object') return false;
    const status = String((p as any).status ?? '');
    if (status === 'waiting_approval' || status === 'waiting_choice') return true;
    return !!(p as any).activeModal;
}

function rankNeedsVerification(c: MagiClaimCluster): number {
    switch (c.category) {
        case 'contested': return 0;
        case 'dissent': return 1;
        case 'source_coupled': return 2;
        case 'singleton': return 3;
        default: return 4;
    }
}

/**
 * Synthesize an arbitrary set of common-schema responses into agreed / contested /
 * dissent / singleton / source_coupled clusters and the primary needs_verification
 * output. N-agnostic and diversity-weighted (distinct provider × machine × evidence),
 * NOT a vote. Pure — fully unit-testable on synthetic responses.
 */
export function synthesizeMagiResponses(
    responses: MagiSynthesizedResponse[],
    opts: { replicasExpected?: number; requireIndependentEvidence?: boolean } = {},
): MagiSynthesis {
    const answered = responses.filter(r => r.source.ok && r.response);
    const requireEvidence = opts.requireIndependentEvidence !== false;

    // 1+2. Flatten claims and greedily cluster by lexical similarity / shared evidence.
    const clusters: ClusterAccumulator[] = [];
    for (const { source, response } of answered) {
        for (const claim of response.claims) {
            const tokens = claimTokenSet(claim.claim);
            const specific = new Set(claim.evidence.filter(isSpecificEvidence).map(normalizeEvidence));
            let best: ClusterAccumulator | null = null;
            let bestScore = 0;
            for (const cluster of clusters) {
                // Shared specific (file:line) evidence forces a merge regardless of wording.
                const evidenceMerge = [...specific].some(e => cluster.specificEvidence.has(e));
                const score = evidenceMerge ? 1 : jaccard(tokens, cluster.tokens);
                if (score > bestScore) { bestScore = score; best = cluster; }
            }
            const member: MagiClusterMember = {
                taskId: source.taskId,
                nodeId: source.nodeId,
                provider: source.provider,
                claim: claim.claim,
                stance: claim.stance,
                evidence: claim.evidence,
                confidence: claim.confidence,
            };
            if (best && bestScore >= MAGI_CLUSTER_JACCARD) {
                best.members.push(member);
                for (const t of tokens) best.tokens.add(t);
                for (const e of specific) best.specificEvidence.add(e);
            } else {
                clusters.push({ members: [member], tokens: new Set(tokens), specificEvidence: new Set(specific) });
            }
        }
    }

    // 3+4+5. Stance + independence per cluster, then categorize.
    const built: MagiClaimCluster[] = clusters.map(cluster => {
        const stance = { support: 0, oppose: 0, uncertain: 0 };
        for (const m of cluster.members) stance[m.stance]++;
        const distinctProviders = new Set(cluster.members.map(m => m.provider).filter(Boolean)).size;
        const distinctNodes = new Set(cluster.members.map(m => m.nodeId).filter(Boolean)).size;
        const distinctEvidence = new Set(cluster.members.flatMap(m => m.evidence.map(normalizeEvidence)).filter(Boolean)).size;
        const distinctAgents = new Set(cluster.members.map(m => m.taskId)).size;
        const maxConfidence = cluster.members.reduce((mx, m) => Math.max(mx, m.confidence), 0);
        const independenceScore = Math.max(distinctProviders, 1) * Math.max(distinctNodes, 1);
        const highIndependence = distinctProviders >= 2 && distinctNodes >= 2;
        const representative = cluster.members.map(m => m.claim).sort((a, b) => b.length - a.length)[0];

        const reasons: string[] = [];
        let category: MagiClaimCluster['category'];
        const hasSupport = stance.support > 0;
        const hasOppose = stance.oppose > 0;
        if (distinctAgents <= 1) {
            category = 'singleton';
            reasons.push('raised by exactly one agent — cannot be cross-checked');
        } else if (hasSupport && hasOppose) {
            if (stance.support > stance.oppose) {
                category = 'dissent';
                reasons.push(`minority opposition (${stance.oppose} oppose vs ${stance.support} support)`);
            } else {
                category = 'contested';
                reasons.push(`stances split (${stance.support} support / ${stance.oppose} oppose / ${stance.uncertain} uncertain)`);
            }
        } else if (highIndependence) {
            category = 'agreed';
        } else {
            category = 'source_coupled';
            reasons.push(`apparent agreement but low independence (${distinctProviders} provider(s) × ${distinctNodes} machine(s))`);
        }

        // require_independent_evidence: a high-impact agreement with no concrete
        // evidence is down-weighted into needs_verification regardless of category.
        let needsVerification = category === 'contested' || category === 'dissent'
            || category === 'singleton' || category === 'source_coupled';
        if (requireEvidence && distinctEvidence === 0 && maxConfidence >= 0.5 && category === 'agreed') {
            needsVerification = true;
            reasons.push('no independent file:line/source evidence for a high-confidence claim');
        }

        return {
            claim: representative,
            category,
            members: cluster.members,
            stance,
            distinctProviders,
            distinctNodes,
            distinctEvidence,
            independenceScore,
            needsVerification,
            reasons,
        };
    });

    const needsVerification = built
        .filter(c => c.needsVerification)
        .sort((a, b) => rankNeedsVerification(a) - rankNeedsVerification(b) || a.independenceScore - b.independenceScore);
    const agreed = built.filter(c => c.category === 'agreed' && !c.needsVerification);

    const distinctProviders = new Set(answered.map(r => r.source.provider).filter(Boolean)).size;
    const distinctNodes = new Set(answered.map(r => r.source.nodeId).filter(Boolean)).size;
    const replicasExpected = opts.replicasExpected ?? responses.length;
    const replicasAnswered = answered.length;

    let independenceBanner: string | null = null;
    if (replicasAnswered >= 1 && (distinctProviders < 2 || distinctNodes < 2)) {
        // The provider/machine spans are computed over the ANSWERING replicas only, so a
        // diverse fan-out whose replicas were mostly DROPPED during collection collapses to
        // "1 provider / 1 machine" — a collection-reliability failure, not a low-diversity
        // panel. Distinguish the two so the reader is pointed at the right cause: when replica
        // loss dominates (missing ≥ answered and something was actually lost), name the loss
        // and the dropped count instead of implying the panel itself was mono-source.
        const replicasMissing = Math.max(0, replicasExpected - replicasAnswered);
        const lossDominated = replicasMissing > 0 && replicasMissing >= replicasAnswered;
        if (lossDominated) {
            // MAGI-DEADLINE-MISLABEL: a dropped replica whose error is `replica_deadline_exceeded`
            // may still be generating its answer somewhere — a later mesh_magi_collect can
            // recover it (the replica's session/task is not gone, collection just stopped
            // waiting). A dropped replica with any OTHER error (unparseable content, stale,
            // failed, cross-wired, no session) is not coming back on its own. These call for
            // different coordinator actions — wait/re-collect vs swap the panel slot — so name
            // the split instead of lumping every drop under one "collection failure" banner.
            const notAnswered = responses.filter(r => !(r.source.ok && r.response));
            const pendingCount = notAnswered.filter(r => r.source.error === 'replica_deadline_exceeded').length;
            const failedCount = notAnswered.length - pendingCount;
            const dropBreakdown = pendingCount > 0 && failedCount > 0
                ? ` (${pendingCount} still pending past the deadline — re-collect may recover them; ${failedCount} genuinely failed/unparseable/stale — those need a panel swap)`
                : pendingCount > 0
                    ? ` (all ${pendingCount} still pending past the deadline — re-collect with mesh_magi_collect may recover them, this is NOT a failed panel)`
                    : ` (all ${failedCount} genuinely failed/unparseable/stale — re-collecting will not recover them, consider a panel swap)`;
            independenceBanner = `independence not achieved — only ${replicasAnswered} of ${replicasExpected} replica(s) answered (${replicasMissing} missing/dropped), collapsing the answering set to ${distinctProviders} provider(s) and ${distinctNodes} machine(s). This is a replica-loss/collection failure, not a low-diversity panel${dropBreakdown}. Agreements are routed to needs_verification.`;
        } else {
            independenceBanner = `independence not achieved — the answering replicas span ${distinctProviders} provider(s) and ${distinctNodes} machine(s); their agreements are source-coupled and routed to needs_verification.`;
        }
    }

    const openQuestions = [...new Set(answered.flatMap(r => r.response.open_questions))];
    const gitSkew = computeMagiGitSkew(answered);

    return {
        replicasExpected,
        replicasAnswered,
        replicasMissing: Math.max(0, replicasExpected - replicasAnswered),
        distinctProviders,
        distinctNodes,
        independenceBanner,
        clusters: built,
        needsVerification,
        agreed,
        openQuestions,
        replicas: responses.map(r => r.source),
        gitSkew,
    };
}

/**
 * deltaA — cross-replica git skew. The answering replicas may have run on nodes at
 * different branches or with local divergence (ahead/behind). When they do, the panel
 * was NOT all looking at the same code, so file:line evidence and "agreement" are
 * git-skewed and should be read with that caveat. Pure over the answering replicas'
 * captured git refs (source.git); refs are best-effort, so a replica with no known
 * branch simply does not contribute one.
 */
export function computeMagiGitSkew(answered: MagiSynthesizedResponse[]): MagiGitSkew {
    const branches = new Set<string>();
    let divergentReplicas = 0;
    for (const { source } of answered) {
        const git = source.git;
        if (!git) continue;
        const branch = typeof git.branch === 'string' && git.branch.trim() ? git.branch.trim() : undefined;
        if (branch) branches.add(branch);
        if ((git.ahead ?? 0) > 0 || (git.behind ?? 0) > 0) divergentReplicas++;
    }
    const branchList = [...branches].sort();
    const skewed = branchList.length > 1 || divergentReplicas > 0;
    return {
        skewed,
        distinctBranches: branchList.length,
        branches: branchList,
        divergentReplicas,
        ...(skewed ? {
            note: branchList.length > 1
                ? `replicas span ${branchList.length} branches (${branchList.join(', ')}) — evidence compares different code; treat agreement with caution.`
                : `${divergentReplicas} replica(s) diverge from upstream (ahead/behind) — not all replicas are on identical code.`,
        } : {}),
    };
}

// ─── Fan-out planning (pure) ────────────────────

export interface MagiReplicaPlan {
    slotIndex: number;
    provider: string;
    /** Resolved concrete node id (pinned slot), else undefined (tag-routed). */
    targetNodeId?: string;
    capabilityTags: string[];
    /** Tags the enqueued task hard-filters on: ['provider=<p>', ...capabilityTags]. */
    requiredTags: string[];
    /** MAGI-KIND-PANEL model axis: model override forwarded to the replica's launch (initialModel). */
    model?: string;
}

export interface MagiUnavailableSlot {
    slotIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    reason: string;
}

/** A slot excluded because every candidate node's health is not launch-ready. */
export interface MagiUnhealthySlot {
    slotIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    /** The resolved health that made the slot unhealthy (e.g. 'degraded', 'offline'). */
    health: string;
    reason: string;
}

/** Per-slot resolution detail (for the git-stale exclusion + the review response surface). */
export interface MagiSlotResolution {
    slotIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    /** Resolves to ≥1 live node (pinned present, or a tag match). */
    available: boolean;
    /** Representative resolved node HEAD commit (best-effort; absent when unknown). */
    headCommit?: string;
    /** True when available AND every candidate node's known HEAD differs from referenceCommit. */
    gitStale: boolean;
    /** True when available but NO candidate node's health is launch-ready (degraded/offline). */
    unhealthy: boolean;
    /** The resolved health of the (representative) candidate node — surfaced for diagnosis. */
    health?: string;
    /** Excluded from the fan-out (unavailable, unhealthy, or git-stale and not include_stale). */
    excluded: boolean;
    reason?: string;
}

export interface MagiFanoutPlan {
    replicas: MagiReplicaPlan[];
    totalRequested: number;
    totalAfterCap: number;
    droppedReplicas: number;
    distinctTargets: number;
    distinctProviders: number;
    distinctNodeTargets: number;
    enoughTargets: boolean;
    coupled: boolean;
    unavailableSlots: MagiUnavailableSlot[];
    /** Slots excluded because every candidate node's health is not launch-ready
     *  (degraded / offline). Without this gate the replica would be assigned to a node
     *  isLaunchableNode refuses, so it parks in `pending` forever — the infinite-wait defect. */
    unhealthySlots: MagiUnhealthySlot[];
    /** The commit the panel is being resolved against (coordinator HEAD); undefined when unknown. */
    referenceCommit?: string;
    /** Per-slot resolution detail, aligned to the kind-panel slot order. */
    slotResolutions: MagiSlotResolution[];
    /** Slots excluded because they are git-stale (different HEAD) and include_stale was not set. */
    staleSlots: MagiSlotResolution[];
    /** Git-stale slots that were nonetheless INCLUDED because include_stale=true (warning surface). */
    includedStaleSlots: MagiSlotResolution[];
}

function replicaCountFor(slot: MagiSlot, defaultN: number | undefined, globalN?: number): number {
    const n = slot.n ?? defaultN ?? globalN ?? 1;
    return Math.max(1, Math.floor(n));
}

/** Best-effort HEAD commit sha off a live node's git status (GitRepoStatus.headCommit). */
function nodeHeadCommit(node: any): string | undefined {
    const h = node?.git?.headCommit;
    return typeof h === 'string' && h.trim() ? h.trim() : undefined;
}

/**
 * Canonical, order-independent key of a node's submodule gitlinks
 * (GitSubmoduleStatus[] on node.git.submodules — path + commit). Two nodes on the
 * same root HEAD but different submodule pointers (the oss/adhdev-providers case,
 * where the submodule carries the actual fix code) must NOT be treated as the same
 * base. Returns undefined when the node carries NO submodule telemetry at all
 * (missing / non-array / empty) — so the caller only compares submodule keys when
 * BOTH sides advertise submodules, and a node without submodule telemetry is never
 * silently excluded (mirrors the missing-HEAD "can't prove → fresh" rule). An empty
 * array is telemetry-absent (no submodules reported), NOT "a repo with zero
 * submodules", so it too yields undefined and falls back to root-HEAD-only compare.
 */
function nodeSubmoduleKey(node: any): string | undefined {
    const subs = node?.git?.submodules;
    if (!Array.isArray(subs) || subs.length === 0) return undefined;
    const parts = subs
        .map((s: any) => {
            const path = typeof s?.path === 'string' ? s.path.trim() : '';
            const commit = typeof s?.commit === 'string' ? s.commit.trim() : '';
            return path && commit ? `${path}@${commit}` : undefined;
        })
        .filter((p: string | undefined): p is string => !!p)
        .sort((a: string, b: string) => a.localeCompare(b));
    return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Whether a candidate node shares the same base as the coordinator reference.
 * Root HEAD must match. Submodule gitlinks are additionally compared ONLY when the
 * reference AND the candidate both carry submodule telemetry — if either side lacks
 * it, we fall back to root-HEAD-only (the pre-fingerprint behavior), so telemetry
 * absence never causes a silent exclusion. A candidate with no known HEAD can't be
 * proven stale and is treated as fresh by the caller (this helper is only consulted
 * once the candidate HEAD is known to match the reference HEAD).
 */
function candidateMatchesReferenceBase(
    candidateHead: string,
    candidateSubKey: string | undefined,
    referenceCommit: string,
    referenceSubKey: string | undefined,
): boolean {
    if (candidateHead !== referenceCommit) return false;
    // Only diff submodule gitlinks when BOTH sides advertise them.
    if (referenceSubKey !== undefined && candidateSubKey !== undefined) {
        return candidateSubKey === referenceSubKey;
    }
    return true;
}

/**
 * Fix B fallback: a node's drift from its OWN upstream (GitCompactSummary.behind/ahead).
 * Used only when no coordinator reference commit is known — a node that reports it is
 * behind/ahead of its upstream is provably on different code than the panel baseline even
 * though we cannot diff explicit HEADs. Returns {behind:0,ahead:0} when the node carries no
 * drift telemetry, so a node with no counters is never proven stale (mirrors the
 * missing-HEAD "can't prove → fresh" rule).
 */
function nodeGitDrift(node: any): { behind: number; ahead: number } {
    const git = node?.git;
    const behind = git && typeof git.behind === 'number' && Number.isFinite(git.behind) ? Math.max(0, git.behind) : 0;
    const ahead = git && typeof git.ahead === 'number' && Number.isFinite(git.ahead) ? Math.max(0, git.ahead) : 0;
    return { behind, ahead };
}
function nodeHasGitDrift(node: any): boolean {
    const { behind, ahead } = nodeGitDrift(node);
    return behind > 0 || ahead > 0;
}

/**
 * Resolve a kind-panel's slots against the live mesh nodes into a concrete fan-out
 * plan: expand each available slot to its replica count, clamp the total to the guard
 * cap (drop logged, never silent), assess (node, provider) target diversity, and
 * flag a panel that collapses to a single provider/machine. Pure.
 */
export function buildMagiFanoutPlan(
    slots: MagiSlot[],
    nodes: LocalMeshNodeEntry[],
    opts: { n?: number; defaultN?: number; maxReplicas?: number; referenceCommit?: string; referenceSubmoduleKey?: string; includeStale?: boolean } = {},
): MagiFanoutPlan {
    const cap = Math.max(1, Math.floor(opts.maxReplicas ?? MAGI_MAX_REPLICAS));
    const slotList = Array.isArray(slots) ? slots : [];
    const defaultN = opts.defaultN;
    const referenceCommit = typeof opts.referenceCommit === 'string' && opts.referenceCommit.trim() ? opts.referenceCommit.trim() : undefined;
    const referenceSubmoduleKey = typeof opts.referenceSubmoduleKey === 'string' && opts.referenceSubmoduleKey.trim() ? opts.referenceSubmoduleKey.trim() : undefined;
    const includeStale = opts.includeStale === true;
    const replicas: MagiReplicaPlan[] = [];
    const unavailableSlots: MagiUnavailableSlot[] = [];
    const unhealthySlots: MagiUnhealthySlot[] = [];
    const slotResolutions: MagiSlotResolution[] = [];
    const targetKeys = new Set<string>();
    const providerSet = new Set<string>();
    const nodeTargetSet = new Set<string>();
    let totalRequested = 0;

    slotList.forEach((slot, slotIndex) => {
        const provider = slot.provider;
        const model = typeof slot.model === 'string' && slot.model.trim() ? slot.model.trim() : undefined;
        const capabilityTags = normalizeMeshCapabilityTags(slot.capabilityTags);
        const requiredTags = normalizeMeshCapabilityTags([`provider=${provider}`, ...capabilityTags]);
        const count = replicaCountFor(slot, defaultN, opts.n);

        // Resolve availability against the mesh, and gather the candidate node(s) so we
        // can assess git staleness against the reference commit.
        let targetNodeId: string | undefined;
        let candidateNodes: any[] = [];
        if (slot.nodeId) {
            const node = nodes.find(n => meshNodeIdMatches(n as any, slot.nodeId!));
            if (node) { targetNodeId = (node as any).id; candidateNodes = [node]; }
        } else {
            // Match against each node's OWN advertised tags (provider derived from its
            // policy.providerPriority), NOT a provider we inject — passing `provider`
            // here would synthesize a provider= tag and make the filter always pass.
            // Mirrors the queue's availability check (mesh-tools-queue.ts).
            candidateNodes = nodes.filter(n => nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(n)));
        }
        const available = candidateNodes.length > 0;

        if (!available) {
            unavailableSlots.push({
                slotIndex,
                provider,
                nodeId: slot.nodeId,
                capabilityTags,
                reason: slot.nodeId
                    ? `pinned node '${slot.nodeId}' is not a member of this mesh`
                    : `no mesh node satisfies required tags [${requiredTags.join(', ')}]`,
            });
            slotResolutions.push({ slotIndex, provider, nodeId: slot.nodeId, capabilityTags, available: false, gitStale: false, unhealthy: false, excluded: true, reason: 'unavailable' });
            return;
        }

        // Health gate (PRIMARY FIX). A slot is available by capability tags, but a node
        // whose P2P/git health is not launch-ready (degraded / offline) is refused by the
        // daemon's auto-launch gate (isLaunchableNode → node_health_not_launchable): the replica
        // task would be assigned yet never launch, parking in `pending` forever with no
        // re-assignment or cancellation — the MAGI infinite-wait defect. So exclude such a
        // slot UP FRONT, exactly as the git-stale gate does. Prefer routing to a launch-ready
        // candidate when the pool is mixed; only exclude when EVERY candidate is unhealthy.
        // 'unknown'/'online' (and absent health) pass — we never exclude on missing telemetry
        // (mirrors the missing-HEAD "can't prove → fresh" rule), so a mesh whose nodes carry
        // no health telemetry behaves exactly as before this gate.
        const launchableCandidates = candidateNodes.filter(n => isMeshNodeHealthLaunchable(n));
        if (launchableCandidates.length === 0) {
            const health = resolveEffectiveMeshNodeHealth(candidateNodes[0]);
            unhealthySlots.push({
                slotIndex,
                provider,
                nodeId: targetNodeId ?? slot.nodeId,
                capabilityTags,
                health,
                reason: slot.nodeId
                    ? `pinned node '${slot.nodeId}' health is '${health}' (not launch-ready)`
                    : `no launch-ready node satisfies required tags [${requiredTags.join(', ')}] — all candidates are '${health}'`,
            });
            slotResolutions.push({
                slotIndex, provider, nodeId: targetNodeId ?? slot.nodeId, capabilityTags,
                available: true, gitStale: false, unhealthy: true, health, excluded: true,
                reason: `node_unhealthy: ${health}`,
            });
            return;
        }
        // Narrow the candidate pool to launch-ready nodes for all downstream resolution
        // (git-staleness, target pinning) so a mixed pool routes to a healthy node.
        if (slot.nodeId && launchableCandidates[0]) targetNodeId = (launchableCandidates[0] as any).id;
        candidateNodes = launchableCandidates;

        // Git staleness vs the reference commit. A slot is git-stale only when a
        // reference commit is known AND every candidate node with a known HEAD differs
        // from it (a node with no known HEAD can't be proven stale → treated as fresh,
        // so we never silently exclude on missing telemetry). Prefer routing to a fresh
        // candidate when one exists.
        let headCommit: string | undefined;
        let gitStale = false;
        if (referenceCommit) {
            const freshCandidate = candidateNodes.find(n => {
                const h = nodeHeadCommit(n);
                // No known HEAD → can't be proven stale → fresh (never exclude on missing
                // telemetry). Otherwise same-base iff root HEAD matches AND — when both the
                // reference and this candidate advertise submodules — the submodule gitlinks
                // match too. Two nodes on the same root HEAD but different oss/adhdev-providers
                // pointer are NOT the same base.
                if (!h) return true;
                return candidateMatchesReferenceBase(h, nodeSubmoduleKey(n), referenceCommit, referenceSubmoduleKey);
            });
            if (freshCandidate) {
                headCommit = nodeHeadCommit(freshCandidate);
                if (slot.nodeId) targetNodeId = (freshCandidate as any).id;
                gitStale = false;
            } else {
                headCommit = nodeHeadCommit(candidateNodes[0]);
                gitStale = true;
            }
        } else {
            // Fix B (stale-gate fallback): the coordinator carries no git HEAD telemetry, so
            // there is no reference commit to diff against. Previously this passed EVERY
            // candidate as fresh (gitStale stays false), so a node sitting behind/ahead of its
            // own upstream silently joined the panel on different code. When drift counters ARE
            // present, use them: prefer a candidate with zero drift; if none is clean but some
            // candidate reports drift, mark the slot git-stale (default-excluded like the
            // HEAD-diff path). A candidate with no drift telemetry at all is still treated as
            // fresh — we never exclude on missing data.
            const freshCandidate = candidateNodes.find(n => !nodeHasGitDrift(n));
            if (freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
                // Mixed pool: route to the clean candidate, leave the slot fresh.
                headCommit = nodeHeadCommit(freshCandidate);
                if (slot.nodeId) targetNodeId = (freshCandidate as any).id;
                gitStale = false;
            } else if (!freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
                // Every candidate reports drift → provably stale relative to its upstream.
                headCommit = nodeHeadCommit(candidateNodes[0]);
                gitStale = true;
            } else {
                // No drift telemetry on any candidate → cannot prove staleness; treat as fresh.
                headCommit = nodeHeadCommit(candidateNodes.find(n => nodeHeadCommit(n)) ?? candidateNodes[0]);
            }
        }

        const resolution: MagiSlotResolution = {
            slotIndex,
            provider,
            nodeId: targetNodeId ?? slot.nodeId,
            capabilityTags,
            available: true,
            ...(headCommit ? { headCommit } : {}),
            gitStale,
            // Candidate pool was already narrowed to launch-ready nodes above, so an
            // included slot is health-launchable by construction.
            unhealthy: false,
            health: resolveEffectiveMeshNodeHealth(candidateNodes[0]),
            excluded: false,
        };

        // Default-exclude a git-stale slot (it would investigate different code than
        // the reference); include_stale=true overrides but the caller surfaces a warning.
        if (gitStale && !includeStale) {
            resolution.excluded = true;
            if (referenceCommit) {
                // Same root HEAD but a differing submodule gitlink is the extended-fingerprint
                // case — name the submodule drift so the surface is not misleading.
                resolution.reason = headCommit && headCommit === referenceCommit
                    ? `git-stale: node HEAD ${headCommit} matches reference but submodule gitlink(s) differ from reference base`
                    : `git-stale: node HEAD ${headCommit ?? '(unknown)'} differs from reference ${referenceCommit}`;
            } else {
                resolution.reason = `git-stale: node reports drift from its upstream (behind/ahead) and no coordinator reference commit is known`;
            }
            slotResolutions.push(resolution);
            return;
        }

        totalRequested += count;
        const targetKey = targetNodeId ? `node:${targetNodeId}` : `tags:${[...requiredTags].sort().join(',')}`;
        targetKeys.add(`${targetKey}|${provider}`);
        providerSet.add(provider);
        nodeTargetSet.add(targetKey);
        slotResolutions.push(resolution);
        for (let i = 0; i < count; i++) {
            replicas.push({ slotIndex, provider, targetNodeId, capabilityTags, requiredTags, ...(model ? { model } : {}) });
        }
    });

    // Clamp to the guard cap (drop the tail; the caller logs the drop).
    const droppedReplicas = Math.max(0, replicas.length - cap);
    const capped = droppedReplicas > 0 ? replicas.slice(0, cap) : replicas;

    const distinctProviders = providerSet.size;
    const distinctNodeTargets = nodeTargetSet.size;
    // enoughTargets / coupled are computed over INCLUDED targets only — i.e. AFTER the
    // health gate AND the git-stale exclusion (unhealthy/stale slots never add to
    // targetKeys) — so the ≥2-independent-target guard re-checks post-exclusion and never
    // silently degrades to N=1.
    const staleSlots = slotResolutions.filter(m => m.gitStale && m.excluded);
    const includedStaleSlots = slotResolutions.filter(m => m.gitStale && !m.excluded);
    return {
        replicas: capped,
        totalRequested,
        totalAfterCap: capped.length,
        droppedReplicas,
        distinctTargets: targetKeys.size,
        distinctProviders,
        distinctNodeTargets,
        enoughTargets: targetKeys.size >= MAGI_MIN_TARGETS,
        coupled: distinctProviders < 2 || distinctNodeTargets < 2,
        unavailableSlots,
        unhealthySlots,
        ...(referenceCommit ? { referenceCommit } : {}),
        slotResolutions,
        staleSlots,
        includedStaleSlots,
    };
}

/**
 * The commit the panel is resolved against for git-staleness: the coordinator node's
 * HEAD (the code the investigation question originates from). Members on a different
 * HEAD would investigate different code and are excluded by default. Undefined when the
 * coordinator node carries no git HEAD telemetry → staleness is simply not computed.
 */
function resolveMagiReferenceCommit(ctx: MeshContext): string | undefined {
    const node = resolveCoordinatorNode(ctx);
    return nodeHeadCommit(node);
}

/**
 * The coordinator node's submodule-gitlink key, paired with the reference commit above
 * to form the base fingerprint (root HEAD + sorted submodule gitlinks). Undefined when
 * the coordinator carries no submodule telemetry → submodule drift is simply not diffed
 * (root-HEAD-only comparison, the pre-fingerprint behavior).
 */
function resolveMagiReferenceSubmoduleKey(ctx: MeshContext): string | undefined {
    const node = resolveCoordinatorNode(ctx);
    return nodeSubmoduleKey(node);
}

// ─── Task prompt (common-schema contract) ───────

const MAGI_CLAIM_AUDIT_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "claims": [ { "claim": "string", "stance": "support | oppose | uncertain", "evidence": ["file:line or external source"], "confidence": 0.0 } ],
  "top_findings": ["string"],
  "open_questions": ["string"]
}
Each claim MUST carry concrete evidence (file:line or a cited source) — unevidenced claims are flagged for re-verification. "stance" is your stance toward the claim being true. Do not invent agreement; report uncertainty honestly.`;

const MAGI_RCA_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "rootCause": "string — the single underlying root cause",
  "failsAt": "file:line — the precise location the failure manifests",
  "mechanism": "string — how the root cause produces the observed symptom",
  "evidence": ["file:line or external source"],
  "fixDirection": "string — the direction a fix should take (do NOT write the fix)",
  "confidence": 0.0
}
"rootCause" and "mechanism" are REQUIRED. "evidence" MUST be non-empty (concrete file:line or cited source) — an empty evidence array is rejected and re-requested. Report uncertainty honestly.`;

const MAGI_DESIGN_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "recommendation": "string — the recommended approach",
  "rationale": "string — why this approach",
  "alternatives": ["string — approaches considered and not chosen"],
  "tradeoffs": ["string"],
  "risks": ["string"],
  "evidence": ["file:line or external source backing the recommendation"],
  "confidence": 0.0
}
"recommendation" and "rationale" are REQUIRED. "evidence" MUST be non-empty — an empty evidence array is rejected and re-requested. Report uncertainty honestly.`;

const MAGI_FREEFORM_CONTRACT = `Answer the question in natural language. No JSON schema is required for this task — write your analysis directly. (Note: a freeform answer is cross-verified only weakly, because it is unstructured.)`;

/** The single output contract injected for a kind — ONE schema, never two (B: no schema-on-schema conflict). */
export function magiOutputContractFor(kind: MagiTaskKind): string {
    switch (kind) {
        case 'rca': return MAGI_RCA_CONTRACT;
        case 'design': return MAGI_DESIGN_CONTRACT;
        case 'freeform': return MAGI_FREEFORM_CONTRACT;
        case 'claim_audit':
        default: return MAGI_CLAIM_AUDIT_CONTRACT;
    }
}

/**
 * Detect that the coordinator accidentally embedded an OUTPUT-FORMAT schema inside the
 * question text. MAGI injects exactly one output contract per kind (B); a second schema
 * in the question collides with it (the antigravity fusion symptom — the agent merges the
 * two and the result is unparseable). We do NOT strip or block it (the question may
 * legitimately quote a schema as the subject of investigation) — we SURFACE a warning so
 * the coordinator removes it. Pure.
 */
export function detectQuestionOutputSchemaConflict(question: string): string | null {
    const q = typeof question === 'string' ? question : '';
    if (!q.trim()) return null;
    const lower = q.toLowerCase();
    const signals = [
        'respond with only',
        'respond with a single json',
        'single json object',
        'output format',
        'output schema',
        'reply with only',
        '"claims"',
        '"top_findings"',
        'matching this exact schema',
    ];
    const hit = signals.find(s => lower.includes(s));
    if (!hit) return null;
    return `The question text appears to embed an output-format schema (matched "${hit}"). MAGI already injects exactly one output contract for the selected task_kind, so a second schema in the question collides with it and replicas may fuse the two into unparseable output. Move any output-format instructions OUT of the question — describe only WHAT to investigate.`;
}

export function buildMagiTaskPrompt(args: {
    question: string;
    target?: string;
    artifacts?: string[];
    mode?: MagiMode;
    taskKind?: MagiTaskKind;
}): string {
    const kind = args.taskKind ?? DEFAULT_TASK_KIND;
    const parts: string[] = [];
    parts.push('You are one independent member of a multi-agent cross-verification quorum (MAGI). Several other agents on different machines/providers are answering the SAME question independently; your job is a rigorous, READ-ONLY investigation. Do NOT write, edit, commit, or push anything.');
    parts.push(`Task kind: ${kind}.`);
    if (args.mode) parts.push(`Investigation mode: ${args.mode}.`);
    parts.push(`\n## Question\n${args.question.trim()}`);
    if (args.target && args.target.trim()) parts.push(`\n## Target to investigate\n${args.target.trim()}`);
    if (Array.isArray(args.artifacts) && args.artifacts.length > 0) {
        parts.push(`\n## Artifacts\n${args.artifacts.map(a => String(a)).join('\n\n---\n\n')}`);
    }
    parts.push(`\n## Output\n${magiOutputContractFor(kind)}`);
    return parts.join('\n');
}

// ─── Worker-output extraction (best-effort) ─────

/**
 * Fix A (summary fallback): ordered list of candidate texts to attempt MAGI parsing on,
 * newest-first. The naive "last assistant bubble content" path misses two real shapes:
 *   1. A mid-turn EMPTY final bubble (the premature-collect symptom) — the parseable
 *      answer lives in an EARLIER assistant bubble.
 *   2. antigravity-cli, which carries the turn's answer in a `summary` field while the
 *      transcript bubble body is empty (_sameAsSummary) — reading the last bubble returns ''
 *      and the real JSON answer is never seen.
 * We therefore gather every assistant bubble's content AND every summary-bearing field
 * (per-message summary/summaryMetadata, and the payload-level summary/finalSummary/
 * lastMessagePreview/text), newest-first, and let the caller parse the first that yields a
 * valid MAGI response. Pure; deduped; empties dropped.
 */
export function collectMagiCandidateTexts(payload: unknown): string[] {
    if (!payload || typeof payload !== 'object') return [];
    const p = payload as Record<string, any>;
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: unknown): void => {
        const text = typeof value === 'string' ? value : '';
        const trimmed = text.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(text);
    };
    const messages = Array.isArray(p.messages) ? p.messages
        : Array.isArray(p.chat) ? p.chat
        : Array.isArray(p.transcript) ? p.transcript
        : [];
    // Walk assistant bubbles newest-first so a finished earlier turn is preferred over an
    // empty in-progress final bubble.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;
        const role = String((msg as any).role || (msg as any).from || '').toLowerCase();
        if (role && role !== 'assistant' && role !== 'agent' && role !== 'model') continue;
        const content = (msg as any).content ?? (msg as any).text ?? (msg as any).message;
        if (typeof content === 'string') push(content);
        else if (Array.isArray(content)) {
            const joined = content
                .map((part: any) => (typeof part === 'string' ? part : (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')))
                .join('');
            push(joined);
        }
        // Per-message summary carriers (antigravity _sameAsSummary case: body empty, answer here).
        push((msg as any).summary);
        push((msg as any).summaryMetadata?.summary);
    }
    // Payload-level summary carriers (compact read_chat lifts the final answer into `summary`).
    push(p.summary);
    push(p.finalSummary);
    push(p.lastMessagePreview);
    push(p.text);
    return out;
}

/** Parse the first MAGI candidate text that yields a valid response, newest-first. */
export function parseFirstMagiCandidate(payload: unknown): MagiAgentResponse | null {
    for (const candidate of collectMagiCandidateTexts(payload)) {
        const parsed = parseMagiResponse(candidate);
        if (parsed) return parsed;
    }
    return null;
}

/**
 * Fix-A-v2: make the summary-fallback actually fire on the collect read path.
 *
 * The collect path reads RAW daemon read_chat (no `compact: true`), and the v1 read-chat
 * contract (read-chat-contract.ts validateReadChatResultPayload / validateMessage) drops the
 * top-level and per-message `summary` carriers that {@link collectMagiCandidateTexts} harvests.
 * So for antigravity — whose final answer lives ONLY in `summary` while the transcript bubble
 * body is empty (_sameAsSummary) — every candidate is empty on the raw payload and the answer
 * is lost as `unparseable_output`. Fix A's harvesting was structurally inert there.
 *
 * Re-derive the summary locally by running the SAME {@link compactChatPayload} lift the daemon's
 * compact path uses (messageContent(finalAssistant) → `summary`), then parse candidates from
 * BOTH payloads:
 *   - the raw payload FIRST — preserves the newest-bubble-first preference and the
 *     premature-collect guard for providers (claude-cli etc.) that keep the JSON in the bubble
 *     body, and never regresses to an older bubble just because compact lifted a newer one;
 *   - the compacted payload as the FALLBACK — surfaces the lifted `summary` so empty-bubble
 *     providers (antigravity) are finally recovered.
 * Candidates are deduped across both sources. Compact is best-effort: a throw leaves the raw
 * candidates intact.
 */
export function parseFirstMagiCandidateWithCompactFallback(
    payload: unknown,
    opts: { sessionId?: string | null } = {},
): MagiAgentResponse | null {
    const rawCandidates = collectMagiCandidateTexts(payload);
    let compactCandidates: string[] = [];
    try {
        compactCandidates = collectMagiCandidateTexts(
            compactChatPayload(payload, { sessionId: opts.sessionId ?? null }),
        );
    } catch { /* compact lift is best-effort — raw candidates still apply */ }
    const seen = new Set<string>();
    for (const candidate of [...rawCandidates, ...compactCandidates]) {
        const trimmed = candidate.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        const parsed = parseMagiResponse(candidate);
        if (parsed) return parsed;
    }
    return null;
}

/**
 * Fix A re-wait gate: a `completed` replica is NOT yet trustworthy for collection when its
 * terminal completion evidence is WEAK (the same insufficient/reviewRecommended/missing-
 * final-assistant signal the daemon shares across the live + ledger paths) OR a short-
 * generating suppressed completion (the early mid-turn bubble that the premature-collect bug
 * mistakes for the final answer). We look up the latest terminal ledger entry for the task —
 * the queue task row does not carry evidenceLevel/completionDiagnostic, but the ledger does
 * (see mesh-event-forwarding terminal payload). Best-effort: a missing/unreadable ledger
 * returns false so we never block collection on telemetry we cannot read.
 */
function replicaCompletionIsWeak(meshId: string, taskId: string): boolean {
    try {
        const entries = readLedgerEntries(meshId, { kind: ['task_completed'], tail: 200 });
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i] as any;
            const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload as Record<string, unknown> : undefined;
            const entryTaskId = readString(payload?.taskId) || readString(entry?.taskId);
            if (!entryTaskId || entryTaskId !== taskId) continue;
            if (isWeakCompletionEvidence(payload)) return true;
            const diag = payload?.completionDiagnostic;
            if (diag && typeof diag === 'object' && !Array.isArray(diag)
                && readString((diag as Record<string, unknown>).reason) === 'short_generating_suppressed') {
                return true;
            }
            return false;
        }
    } catch { /* ledger unreadable — do not block collection */ }
    return false;
}

// ─── Handlers ───────────────────────────────────

/**
 * The scope descriptor every kind-panel response carries. Panels are stored PER MESH
 * (machine-local `~/.adhdev/meshes.json` → `meshes[].magiKindPanels`), so a bare
 * `scope: 'machine_local'` string — what these handlers used to return — understated
 * it and read as one global binding per task_kind. Naming the resolved mesh makes the
 * scope unambiguous at the call site.
 */
function magiPanelScope(meshId: string, meshName?: string) {
    return {
        kind: 'mesh' as const,
        storage: 'machine_local' as const,
        meshId,
        ...(meshName ? { meshName } : {}),
        note: 'Kind-panels are per mesh, stored machine-locally (not repo-committed). Another mesh on this machine has its own independent bindings.',
    };
}

/**
 * Set the MAGI kind→panel slot binding for one task_kind, scoped to THIS coordinator's
 * mesh (machine-local `~/.adhdev/meshes.json` → `meshes[].magiKindPanels`). MCP surface
 * for the daemon `magi_kind_panel_set` command.
 *
 * IMPORTANT — kind-slot write is a WHOLESALE REPLACEMENT of the slot list for that
 * kind (a task_kind has exactly one binding per mesh; setMagiKindPanel always
 * overwrites). So this is NOT an additive upsert — the passed `slots` become the
 * complete new set and any prior slots for the kind are dropped. It therefore requires
 * explicit user approval before a write (present the current-vs-new slot lists first).
 * Mirrors the mesh_magi_panel_set write/dry-run precedent: defaults to dry-run
 * (write=false). A slot's optional `nodeId` must name a node of this mesh — a foreign
 * node id is rejected rather than silently stored.
 */
export async function meshMagiKindPanelSet(
    ctx: MeshContext,
    args: { task_kind?: string; kind?: string; slots?: unknown; write?: boolean },
): Promise<string> {
    const kind = readString(args.task_kind) || readString(args.kind);
    if (!kind) return JSON.stringify({ success: false, error: 'task_kind required' });
    const write = args.write === true;
    const meshId = ctx.mesh.id;
    const scope = magiPanelScope(meshId, ctx.mesh.name);
    try {
        // The current binding for this kind, so the coordinator can diff current-vs-new
        // before an overwrite (the write drops any slot not in the new list).
        const current: MagiSlot[] = getMagiKindPanel(kind, meshId) ?? [];
        // A MagiSlot is a deliberately reduced schema (provider + optional model/nodeId/
        // capabilityTags/n) — the normalizer drops everything else silently, which is
        // right for read-back but used to make a `thinkingLevel` on a write a no-op with
        // no signal. Surface the drops on BOTH branches: a dry-run that hid them would
        // let the operator approve a payload whose ignored keys only show up after the
        // write. Never fatal — the slots still normalize and persist exactly as before.
        const ignoredFields = collectIgnoredMagiSlotFields(args.slots);
        const ignoredNote = ignoredFields.length
            ? { ignoredFields, ignoredFieldsNote: 'These keys are not part of the MAGI slot schema and were DROPPED (the panel was still saved without them). A MAGI panel decides WHO answers independently; per-slot routing axes like thinkingLevel/difficulty/maxParallel belong on the node capability slots (mesh_node_slots_set).' }
            : {};
        if (!write) {
            // Dry-run: normalize + validate WITHOUT persisting (same normalizer AND the
            // same mesh node list as the persisted write path, so a preview that passes
            // cannot fail at write time on an unknown nodeId).
            const preview = normalizeMagiSlots(args.slots, ctx.mesh.nodes.map(n => n.id));
            return JSON.stringify({
                success: true,
                dryRun: true,
                taskKind: kind,
                scope,
                replacement: true,
                currentSlots: current,
                slots: preview,
                ...ignoredNote,
                note: `Dry-run only — no file written. This is a WHOLESALE replacement of the kind's slot list for mesh '${meshId}' (machine-local ~/.adhdev/meshes.json); the currentSlots would be fully replaced. Other meshes on this machine are unaffected. Re-run with write=true after explicit user approval.`,
            }, null, 2);
        }
        const slots = setMagiKindPanel(kind, args.slots, meshId);
        return JSON.stringify({
            success: true,
            written: true,
            taskKind: kind,
            scope,
            replacement: true,
            previousSlots: current,
            slots,
            ...ignoredNote,
            nextAction: 'Verify with mesh_magi_kind_panel_list, then mesh_magi_review({ task_kind }) resolves this binding.',
        }, null, 2);
    } catch (e: any) {
        const message = e?.message || String(e);
        const code = message.includes('invalid_magi_kind_panel') ? 'invalid_magi_kind_panel' : undefined;
        return JSON.stringify({ success: false, ...(code ? { code } : {}), scope, error: message });
    }
}

/**
 * List the kind→panel slot bindings configured for THIS coordinator's mesh. Read-only.
 * Use to confirm what a `task_kind` resolves to before mesh_magi_review, and to diff
 * before an overwrite. The response names the mesh the bindings belong to — panels are
 * per mesh, so "configured" is only ever meaningful relative to one.
 */
export async function meshMagiKindPanelList(
    ctx: MeshContext,
    args: { task_kind?: string; kind?: string } = {},
): Promise<string> {
    const only = readString(args.task_kind) || readString(args.kind);
    const meshId = ctx.mesh.id;
    const scope = magiPanelScope(meshId, ctx.mesh.name);
    const all = listMagiKindPanels(meshId);
    if (only) {
        const slots = getMagiKindPanel(only, meshId);
        if (slots === undefined) {
            return JSON.stringify({
                success: false,
                code: 'magi_kind_not_configured',
                error: `task_kind '${only}' has no configured kind-panel binding in mesh '${meshId}'`,
                scope,
                configuredKinds: Object.keys(all),
            }, null, 2);
        }
        return JSON.stringify({ success: true, scope, taskKind: only, slots }, null, 2);
    }
    return JSON.stringify({ success: true, scope, kindPanels: all, configuredKinds: Object.keys(all) }, null, 2);
}


// MAGI-KIND-PANEL: the panel a mesh_magi_review fans out to is resolved SOLELY from the
// user's explicitly configured kind-panel binding (magiKindPanels: task_kind → slots).
// The former named-panel / inline-members / preset-auto-synthesis paths were REMOVED —
// an unconfigured task_kind is a hard error (magi_kind_not_configured). See the panel
// resolution block in meshMagiReview.

export async function meshMagiReview(
    ctx: MeshContext,
    args: {
        question?: string;
        target?: string;
        artifacts?: string[];
        n?: number;
        mode?: string;
        require_independent_evidence?: boolean;
        requireIndependentEvidence?: boolean;
        include_stale?: boolean;
        includeStale?: boolean;
        wait?: boolean;
        wait_timeout_ms?: number;
        waitTimeoutMs?: number;
        task_kind?: string;
        taskKind?: string;
        auto_cleanup?: boolean;
        autoCleanup?: boolean;
    },
): Promise<string> {
    const question = readString(args.question);
    if (!question) return JSON.stringify({ success: false, error: 'question required' });

    // task_kind is REQUIRED — it is BOTH the output-schema selector AND the sole panel
    // resolution key (magiKindPanels: task_kind → slots). There is no named-panel /
    // inline-members / preset fallback, so an omitted or unrecognized task_kind is a hard
    // error rather than a normalize-to-default.
    const explicitTaskKind = args.task_kind ?? args.taskKind;
    if (typeof explicitTaskKind !== 'string' || !(VALID_TASK_KINDS as readonly string[]).includes(explicitTaskKind.trim().toLowerCase())) {
        return JSON.stringify({
            success: false,
            code: 'task_kind_required',
            error: 'task_kind is required and selects both the output schema and the configured kind-panel slots. Pass one of: claim_audit / rca / design / freeform.',
            validTaskKinds: VALID_TASK_KINDS,
            hint: 'Configure the kind-panel slots for this task_kind in mesh settings (magiKindPanels) or via mesh_magi_kind_panel_set, then call mesh_magi_review({ question, task_kind }).',
        }, null, 2);
    }
    // B: warn (do NOT block) if the coordinator embedded an output schema in the question —
    // it collides with the single kind contract MAGI injects and causes fusion/unparseable.
    const questionSchemaWarning = detectQuestionOutputSchemaConflict(question);

    await refreshMeshFromDaemon(ctx);

    // Reference commit (coordinator HEAD) is read here, immediately after the mesh
    // refresh, so slot resolution pins fresh live nodes against the SAME baseline
    // buildMagiFanoutPlan uses for git-staleness. read-only — safe to hoist.
    const referenceCommit = resolveMagiReferenceCommit(ctx);
    // Extend the base fingerprint with the coordinator's submodule gitlinks so two nodes
    // on the SAME root HEAD but a different oss/adhdev-providers pointer are not treated
    // as the same base (that submodule carries the actual fix code). Undefined when the
    // coordinator has no submodule telemetry → root-HEAD-only comparison (pre-fingerprint).
    const referenceSubmoduleKey = resolveMagiReferenceSubmoduleKey(ctx);

    // 1. Resolve the panel SOLELY from the user's configured kind→slots binding
    // (magiKindPanels). There is NO named-panel, inline-members, or preset auto-synthesis
    // path — an unconfigured kind is a hard error so the user must explicitly bind
    // (machine + provider + model) slots in mesh settings. The final output kind is the
    // task_kind itself (validated above); there is no panel-level defaultKind to fill in.
    const taskKind = normalizeMagiTaskKind(explicitTaskKind);
    const panelName = `(kind:${taskKind})`;
    // Panels are per mesh — resolve against THIS coordinator's mesh so a binding never
    // leaks in from another mesh on the same machine (whose slots name its own nodes).
    const slots = getMagiKindPanel(taskKind, ctx.mesh.id);
    if (!slots || slots.length === 0) {
        return JSON.stringify({
            success: false,
            code: 'magi_kind_not_configured',
            error: `No panel slots are configured for this task_kind in mesh '${ctx.mesh.id}' settings. Add at least one (machine + provider + model) slot in settings — task_kind '${taskKind}' has no configured kind-panel.`,
            taskKind,
            meshId: ctx.mesh.id,
            configuredKinds: Object.keys(listMagiKindPanels(ctx.mesh.id)),
            hint: 'Configure this kind in mesh settings (MagiKindPanelEditor), or set it with mesh_magi_kind_panel_set, then retry.',
        }, null, 2);
    }
    // Slots are already normalized at write time (setMagiKindPanel → normalizeMagiSlots),
    // but re-normalize here so a bad stored slot surfaces a clear error before dispatch.
    // Deliberately WITHOUT the mesh node list: a slot whose node has since left the mesh
    // must not hard-fail the whole review — it is skipped below with a reason instead.
    let planSlots: MagiSlot[];
    try {
        planSlots = normalizeMagiSlots(slots);
    } catch (e: any) {
        return JSON.stringify({
            success: false,
            code: 'invalid_magi_kind_panel',
            error: `configured kind-panel for '${taskKind}' is invalid: ${e?.message || String(e)}`,
            taskKind,
            meshId: ctx.mesh.id,
            hint: 'Re-save the kind-panel slots in mesh settings — each slot needs a provider; nodeId / model are optional.',
        }, null, 2);
    }

    // Drop slots pinned to a node this mesh no longer has (removed between the write
    // and now, or carried over from a legacy global binding written by another mesh).
    // Skipped WITH a reason rather than dispatched — a dangling pin would otherwise
    // park a replica in 'pending' forever. The ≥2-target floor below is enforced AFTER
    // this exclusion, so the panel still never silently degrades to N=1.
    const meshNodeIds = new Set(ctx.mesh.nodes.map(n => n.id));
    const danglingSlots = planSlots.filter(s => s.nodeId && !meshNodeIds.has(s.nodeId));
    if (danglingSlots.length) {
        planSlots = planSlots.filter(s => !s.nodeId || meshNodeIds.has(s.nodeId));
        if (planSlots.length === 0) {
            return JSON.stringify({
                success: false,
                code: 'magi_kind_panel_all_slots_dangling',
                error: `Every slot in kind-panel '${panelName}' is pinned to a node that is not in mesh '${ctx.mesh.id}' (${danglingSlots.map(s => s.nodeId).join(', ')}).`,
                taskKind,
                meshId: ctx.mesh.id,
                danglingSlots,
                hint: 'Re-bind this kind to nodes of THIS mesh with mesh_magi_kind_panel_set (or in mesh settings). Check mesh_status for the current node list.',
            }, null, 2);
        }
    }

    // 2. Plan the fan-out. Git-stale slots (node HEAD differs from the coordinator's
    // reference commit) are EXCLUDED by default — they would investigate different code;
    // include_stale=true keeps them (with a warning). The ≥2-target guard below is
    // re-checked AFTER this exclusion, so it never silently degrades to N=1.
    const includeStale = (args.include_stale ?? args.includeStale) === true;
    const plan = buildMagiFanoutPlan(planSlots, ctx.mesh.nodes, { n: args.n, referenceCommit, referenceSubmoduleKey, includeStale });
    if (!plan.enoughTargets) {
        const droppedByStale = plan.staleSlots.length > 0;
        const droppedByHealth = plan.unhealthySlots.length > 0;
        // Health exclusion is the PRIMARY new failure cause: a degraded/offline node was
        // excluded up front (it would have parked in `pending` forever). Surface it as a
        // distinct code so the coordinator knows the panel is under-quorum because a node
        // is unhealthy — NOT because the panel is mis-configured — and never silently
        // degrades to N=1.
        const code = droppedByHealth
            ? 'magi_insufficient_targets_after_health_exclusion'
            : droppedByStale
                ? 'magi_insufficient_targets_after_stale_exclusion'
                : 'magi_insufficient_targets';
        const error = droppedByHealth
            ? `Kind-panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.unhealthySlots.length} unhealthy slot(s) (${plan.unhealthySlots.map(s => `${s.nodeId ?? `[${s.provider}]`}=${s.health}`).join(', ')}); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1. A degraded node would leave its replica parked in 'pending' forever, so it is excluded rather than dispatched.`
            : droppedByStale
                ? `Kind-panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.staleSlots.length} git-stale slot(s) (HEAD differs from reference ${referenceCommit ?? '(unknown)'}); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`
                : `Kind-panel '${panelName}' resolves to ${plan.distinctTargets} available (node, provider) target(s); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`;
        const hint = droppedByHealth
            ? 'Bring the degraded node(s) back online (check P2P/git health via mesh_status), or configure additional healthy (machine + provider) slots for this kind-panel, then retry.'
            : droppedByStale
                ? 'Bring the stale node(s) to the reference commit, or pass include_stale=true to mesh_magi_review to fan out to them anyway (results will be git-skewed).'
                : 'Fix the kind-panel slots with mesh_magi_kind_panel_set (or in mesh settings), and use mesh_status to confirm nodes/providers are online.';
        return JSON.stringify({
            success: false,
            code,
            error,
            ...(referenceCommit ? { referenceCommit } : {}),
            unavailableSlots: plan.unavailableSlots,
            ...(droppedByHealth ? { unhealthySlots: plan.unhealthySlots } : {}),
            ...(droppedByStale ? { staleSlots: plan.staleSlots } : {}),
            // Surface slots dropped for naming a node outside this mesh, so an
            // under-quorum panel caused by a stale pin is diagnosable rather than
            // looking like a mis-sized panel.
            ...(danglingSlots.length ? { danglingSlots } : {}),
            hint,
        }, null, 2);
    }

    const mode = readString(args.mode) as MagiMode | '';
    const requireIndependentEvidence = (args.require_independent_evidence ?? args.requireIndependentEvidence) !== false;
    const wait = args.wait !== false;
    const waitTimeoutMs = resolveMagiWaitTimeoutMs(args.wait_timeout_ms ?? args.waitTimeoutMs);

    // 3. Mission container + shared consensus group id.
    const consensusGroupId = `magi_${randomUUID().replace(/-/g, '')}`;
    const titleQ = question.length > 80 ? `${question.slice(0, 77)}...` : question;
    const mission = upsertMeshMission(ctx.mesh.id, {
        title: `MAGI: ${titleQ}`,
        goal: `Cross-verify (read-only) across panel '${panelName}': ${question}${args.target ? `\nTarget: ${args.target}` : ''}`,
        // Tag provenance so the completed inline mission is bounded out of the default
        // mesh_mission_list (these accumulate one-per-run and auto-close on collection).
        source: 'magi',
    });

    // 4. Enqueue one read-only task per replica, all sharing the consensus group id.
    const prompt = buildMagiTaskPrompt({ question, target: args.target, artifacts: args.artifacts, mode: (mode || undefined) as MagiMode | undefined, taskKind });
    const replicaRecords: Array<{ taskId: string; provider: string; targetNodeId?: string; requiredTags: string[] }> = [];
    for (const replica of plan.replicas) {
        try {
            const task = enqueueTask(ctx.mesh.id, prompt, {
                readonly: true,
                taskMode: 'live_debug_readonly',
                // DIFFICULTY-REQUIRED (MAGI decision): a fixed 'freeform' sentinel, NOT an
                // exemption from the guard. MAGI routes on a different axis entirely — each
                // replica is already hard-pinned to a (node, provider) slot by the kind-panel
                // via requiredTags (`provider=<X>`) and often an explicit targetNodeId, and
                // its model comes from that slot. Difficulty exists to MATCH a task against
                // node capability slots at assignment time; here the slot is already chosen,
                // so any difficulty we stamped would be inert at best and would fight the
                // panel's own slot selection at worst.
                //
                // 'freeform' is the correct sentinel rather than a guard bypass: it is a real
                // member of the axis meaning "no difficulty-based constraint", so the fan-out
                // satisfies the required-difficulty invariant honestly instead of carving out
                // a hole that a future non-MAGI caller could slip through. Deliberately NOT
                // caller-configurable — exposing a difficulty knob on mesh_magi_review would
                // imply it influences replica placement, which it does not.
                difficulty: 'freeform',
                requiredTags: replica.requiredTags,
                missionId: mission.id,
                consensusGroupId,
                ...(replica.targetNodeId ? { targetNodeId: replica.targetNodeId } : {}),
                ...(replica.model ? { model: replica.model } : {}),
                ...(ctx.coordinatorSessionId ? { sourceCoordinatorSessionId: ctx.coordinatorSessionId } : {}),
            });
            replicaRecords.push({ taskId: task.id, provider: replica.provider, targetNodeId: replica.targetNodeId, requiredTags: replica.requiredTags });
        } catch (e: any) {
            // A single replica enqueue failure must not abort the quorum — record and continue.
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'magi_replica_enqueue_failed' as any,
                    payload: { consensusGroupId, missionId: mission.id, provider: replica.provider, error: e?.message || String(e) },
                });
            } catch { /* ledger write is best-effort */ }
        }
    }
    if (replicaRecords.length < MAGI_MIN_TARGETS) {
        return JSON.stringify({ success: false, code: 'magi_enqueue_failed', error: 'fewer than 2 replicas enqueued successfully', consensusGroupId, missionId: mission.id });
    }

    // deltaE: persist the fan-out so the group is visible in mesh_status (running) and
    // survives a coordinator restart even before any synthesis is collected.
    persistMagiDispatched(ctx, {
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        replicaCount: replicaRecords.length,
        taskKind,
    });

    // 5. Trigger queue pickup. This is the SOLE dispatch path for every replica,
    // local AND remote. triggerMeshQueue (on the coordinator's local IPC) drains
    // each pending replica task — including ones pinned to a remote node — to its
    // target: a remote idle session is claimed and send_chat'd over P2P, and a
    // pinned remote target with no idle session is auto-launched, then claims on
    // ready. A previously-eager P2P push to remote replicas (eagerlyDispatchRemote-
    // Replicas) was a SECOND, redundant send of the same prompt: the queue path
    // already delivers the task, so both writes raced and each bypassed the
    // recent-duplicate-send guard — the cross-machine MAGI double-send. Removed so
    // every replica is dispatched exactly once via the queue.
    const queueTrigger = await triggerMeshQueueAndReport(ctx);

    const baseResult = {
        success: true,
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        taskKind,
        ...(questionSchemaWarning ? { questionSchemaWarning } : {}),
        question,
        replicaCount: replicaRecords.length,
        replicas: replicaRecords.map(r => ({ taskId: r.taskId, provider: r.provider, targetNodeId: r.targetNodeId })),
        independence: {
            distinctProviders: plan.distinctProviders,
            distinctMachines: plan.distinctNodeTargets,
            coupled: plan.coupled,
            ...(plan.coupled ? { banner: 'Panel collapsed to a single provider or machine — agreements will be flagged source-coupled.' } : {}),
        },
        ...(plan.referenceCommit ? { referenceCommit: plan.referenceCommit } : {}),
        // Surface health-gate exclusions even when quorum still held: these replicas were
        // NEVER dispatched (their node is degraded/offline and would park in `pending`
        // forever), so the coordinator/collect must know not to wait on them.
        ...(plan.unhealthySlots.length > 0 ? {
            excludedSlots: plan.unhealthySlots,
            healthExcludedWarning: `${plan.unhealthySlots.length} slot(s) were excluded from this fan-out because their node health is not launch-ready (${plan.unhealthySlots.map(s => `${s.nodeId ?? `[${s.provider}]`}=${s.health}`).join(', ')}) — those replicas were NOT dispatched. Bring the node(s) online (mesh_status) to include them.`,
        } : {}),
        // Surface git-stale handling: which slots were excluded (default), or included
        // despite being stale (include_stale=true) — the latter makes results git-skewed.
        ...(plan.staleSlots.length > 0 ? {
            gitStaleExcluded: plan.staleSlots,
            gitStaleWarning: `${plan.staleSlots.length} git-stale slot(s) (HEAD ≠ reference ${plan.referenceCommit ?? '(unknown)'}) were excluded from this fan-out; pass include_stale=true to include them.`,
        } : {}),
        ...(plan.includedStaleSlots.length > 0 ? {
            gitStaleIncluded: plan.includedStaleSlots,
            gitStaleWarning: `include_stale=true: ${plan.includedStaleSlots.length} git-stale slot(s) (HEAD ≠ reference ${plan.referenceCommit ?? '(unknown)'}) were INCLUDED — their evidence compares different code, so synthesis will be git-skewed.`,
        } : {}),
        ...(plan.droppedReplicas > 0 ? {
            cappedReplicas: plan.droppedReplicas,
            cappedNote: `Total replicas requested (${plan.totalRequested}) exceeded the guard cap (${MAGI_MAX_REPLICAS}); ${plan.droppedReplicas} dropped (logged, not silent).`,
        } : {}),
        costNote: `MAGI dispatched ${replicaRecords.length} read-only sessions — token spend scales with the replica count.`,
        queueTrigger,
    };

    if (!wait) {
        return JSON.stringify({
            ...baseResult,
            waited: false,
            pollWith: { tool: 'mesh_magi_collect', args: { consensus_group_id: consensusGroupId } },
            nextAction: `Replicas are running. Drive off mission completion / pendingCoordinatorEvents rather than polling chat, then collect + synthesize once with mesh_magi_collect({ consensus_group_id: '${consensusGroupId}' }).`,
        }, null, 2);
    }

    // 6. Collect by consensus group id (bounded), then synthesize.
    const collected = await collectMagiResponses(ctx, {
        replicaTaskIds: replicaRecords.map(r => r.taskId),
        timeoutMs: waitTimeoutMs,
        taskKind,
    });
    const synthesis = synthesizeMagiResponses(collected.responses, {
        replicasExpected: replicaRecords.length,
        requireIndependentEvidence,
    });
    // mesh_magi_review has no rawAnswer contract — strip the per-replica raw text from
    // both the persisted ledger entry and the returned synthesis. rawAnswer is surfaced
    // only via mesh_magi_collect verbose.
    const synthesisNoRaw = stripRawAnswers(synthesis);
    // freeform contributes no structured claims, so cross-verification is weak — banner it.
    const freeformBanner = taskKind === 'freeform'
        ? 'task_kind=freeform: answers are unstructured natural language; cross-verification is WEAK (no claim clustering / independence scoring). Treat the collected answers as parallel opinions, not a verified consensus.'
        : null;

    // deltaE: persist the synthesis (retrievable by consensusGroupId; folds into mesh_status).
    persistMagiSynthesis(ctx, {
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        staleReplicas: collected.staleCount,
        synthesis: synthesisNoRaw,
    });
    // FIX#3: this inline review owns `mission` — auto-close it once all replicas are terminal.
    closeMagiMissionIfTerminal(ctx, mission.id, collected.terminal);

    // Post-review auto-cleanup (default ON): stop+delete ONLY the worker sessions this
    // fan-out auto-launched, gated terminal. Re-read the replica tasks from the live queue
    // so we see their final assignedSessionId / autoLaunch.sessionId. Best-effort.
    const cleanupMode = resolveMagiAutoCleanupMode(ctx, args.auto_cleanup ?? args.autoCleanup);
    const cleanupReplicaTasks = findMagiReplicaTasks(getQueue(ctx.mesh.id), consensusGroupId);
    const cleanup = await cleanupMagiAutoLaunchedSessions(ctx, {
        replicaTasks: cleanupReplicaTasks,
        terminal: collected.terminal,
        mode: cleanupMode,
    });

    return JSON.stringify({
        ...baseResult,
        waited: true,
        ...(cleanup ? { sessionCleanup: { mode: cleanupMode, cleanedSessionCount: cleanup.cleanedSessionCount, perNode: cleanup.perNode } } : {}),
        collection: {
            terminal: collected.terminal,
            timedOut: collected.timedOut,
            answered: synthesis.replicasAnswered,
            missing: synthesis.replicasMissing,
            staleReplicas: collected.staleCount,
            ...(collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE — assigned to a node/session no longer present in the live mesh; collection stopped early rather than waiting out the timeout.` } : {}),
            ...(collected.retriedCount > 0 ? { retriedReplicas: collected.retriedCount, retryNote: `${collected.retriedCount} replica(s) failed the ${taskKind} schema and were sent one delta re-request for a corrected single-JSON answer.` } : {}),
            ...(synthesis.replicasMissing > 0 ? { missingNote: `Partial synthesis — ${synthesis.replicasMissing} of ${replicaRecords.length} replicas did not return a parseable response (timed out / failed / unparseable / schema-invalid / stale).` } : {}),
        },
        ...(freeformBanner ? { freeformBanner } : {}),
        synthesis: synthesisNoRaw,
    }, null, 2);
}

/**
 * Poll-by-group collection (featureC). Re-collect + synthesize a previously
 * dispatched MAGI fan-out by its consensus group id — the async companion to a
 * wait=false mesh_magi_review. Rediscovers the replica tasks from the queue, then
 * reuses the SAME collectMagiResponses + synthesizeMagiResponses code paths as the
 * wait=true review (no duplicated collection/synthesis). Tolerates partial/stale
 * replicas: when wait=false it snapshots whatever is terminal right now.
 */
export async function meshMagiCollect(
    ctx: MeshContext,
    args: {
        consensus_group_id?: string;
        consensusGroupId?: string;
        require_independent_evidence?: boolean;
        requireIndependentEvidence?: boolean;
        wait?: boolean;
        wait_timeout_ms?: number;
        waitTimeoutMs?: number;
        task_kind?: string;
        taskKind?: string;
        auto_cleanup?: boolean;
        autoCleanup?: boolean;
        verbose?: boolean;
    },
): Promise<string> {
    const consensusGroupId = readString(args.consensus_group_id) || readString(args.consensusGroupId);
    if (!consensusGroupId) return JSON.stringify({ success: false, error: 'consensus_group_id required' });

    await refreshMeshFromDaemon(ctx);

    // MAGI-REDESIGN: recover the kind this group was dispatched with from the ledger so the
    // right schema parser is used (collect rediscovers replicas from the queue, not the call).
    // An explicit task_kind arg overrides (escape hatch if the dispatched ledger was pruned).
    const explicitKind = args.task_kind ?? args.taskKind;
    const taskKind = explicitKind !== undefined
        ? normalizeMagiTaskKind(explicitKind)
        : recoverMagiTaskKind(ctx, consensusGroupId);

    const replicaTasks = findMagiReplicaTasks(getQueue(ctx.mesh.id), consensusGroupId);
    if (replicaTasks.length === 0) {
        return JSON.stringify({
            success: false,
            code: 'magi_group_not_found',
            error: `No MAGI replicas found for consensus group '${consensusGroupId}'. It may have been pruned, or the id is wrong.`,
            consensusGroupId,
        });
    }

    const requireIndependentEvidence = (args.require_independent_evidence ?? args.requireIndependentEvidence) !== false;
    // Default to a SNAPSHOT (wait=false): poll-by-group is the async path, so the
    // common case is "collect whatever finished so far". Pass wait=true to block for
    // the remaining replicas up to wait_timeout_ms.
    const wait = args.wait === true;
    const timeoutMs = wait
        ? resolveMagiWaitTimeoutMs(args.wait_timeout_ms ?? args.waitTimeoutMs)
        : 0;

    const replicaTaskIds = replicaTasks.map((t: any) => readString(t.id)).filter(Boolean) as string[];
    const collected = await collectMagiResponses(ctx, { replicaTaskIds, timeoutMs, taskKind });
    const synthesis = synthesizeMagiResponses(collected.responses, {
        replicasExpected: replicaTaskIds.length,
        requireIndependentEvidence,
    });
    // rawAnswer gate: always strip from the persisted ledger entry (bounds payload).
    // The RETURNED synthesis carries rawAnswer only when verbose=true; default strips it.
    const verbose = args.verbose === true;
    const synthesisNoRaw = stripRawAnswers(synthesis);
    const returnedSynthesis = verbose ? synthesis : synthesisNoRaw;
    const freeformBanner = taskKind === 'freeform'
        ? 'task_kind=freeform: answers are unstructured natural language; cross-verification is WEAK (no claim clustering / independence scoring). Treat the collected answers as parallel opinions, not a verified consensus.'
        : null;

    // deltaE: persist the synthesis (panel/question are merged from the earlier
    // magi_dispatched entry by consensusGroupId, so they need not be re-derived here).
    const replicaMissionId = readString(replicaTasks[0]?.missionId);
    persistMagiSynthesis(ctx, {
        consensusGroupId,
        missionId: replicaMissionId,
        staleReplicas: collected.staleCount,
        synthesis: synthesisNoRaw,
    });
    // FIX#3: the inline mission id comes from the replica tasks' OWN missionId (MAGI-owned,
    // guard a) — auto-close it once all replicas are terminal.
    closeMagiMissionIfTerminal(ctx, replicaMissionId, collected.terminal);

    // Post-collect auto-cleanup (default ON), gated terminal so a partial snapshot never
    // kills still-generating replicas. Reuse the rediscovered replicaTasks. Best-effort.
    const cleanupMode = resolveMagiAutoCleanupMode(ctx, args.auto_cleanup ?? args.autoCleanup);
    const cleanup = await cleanupMagiAutoLaunchedSessions(ctx, {
        replicaTasks,
        terminal: collected.terminal,
        mode: cleanupMode,
    });

    return JSON.stringify({
        success: true,
        consensusGroupId,
        taskKind,
        replicaCount: replicaTaskIds.length,
        waited: wait,
        ...(cleanup ? { sessionCleanup: { mode: cleanupMode, cleanedSessionCount: cleanup.cleanedSessionCount, perNode: cleanup.perNode } } : {}),
        collection: {
            terminal: collected.terminal,
            timedOut: collected.timedOut,
            answered: synthesis.replicasAnswered,
            missing: synthesis.replicasMissing,
            staleReplicas: collected.staleCount,
            ...(collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE — assigned to a node/session no longer present in the live mesh.` } : {}),
            ...(collected.retriedCount > 0 ? { retriedReplicas: collected.retriedCount, retryNote: `${collected.retriedCount} replica(s) failed the ${taskKind} schema and were sent one delta re-request for a corrected single-JSON answer.` } : {}),
            ...(!collected.terminal ? { pendingNote: 'Not all replicas are terminal yet — this is a partial snapshot. Re-collect once mission/pendingCoordinatorEvents report more completions.' } : {}),
        },
        ...(freeformBanner ? { freeformBanner } : {}),
        ...(verbose ? { rawAnswersIncluded: true } : {}),
        synthesis: returnedSynthesis,
    }, null, 2);
}

// ─── Collection (best-effort, bounded) ──────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const MAGI_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Discover the replica tasks of a MAGI fan-out by their shared consensus group id.
 * Drives poll-by-group collection (mesh_magi_collect): a wait=false review returns
 * the group id, and a later call rediscovers the replicas straight from the queue —
 * no need to thread the original task-id list back through the caller. Pure given a
 * queue snapshot.
 */
export function findMagiReplicaTasks(queue: any[], consensusGroupId: string): any[] {
    const groupId = typeof consensusGroupId === 'string' ? consensusGroupId.trim() : '';
    if (!groupId) return [];
    return (Array.isArray(queue) ? queue : []).filter((t: any) => readString(t?.consensusGroupId) === groupId);
}

// ─── Post-review auto-cleanup of MAGI-launched worker sessions ──────────────
//
// MAGI fans a question out to N independent (node × provider) replicas. For a pinned
// target with no idle session the QUEUE auto-launches a fresh worker session, stamping
// settings.autoLaunchedForQueueTaskId = task.id onto it (mesh-queue-assignment.ts) which
// the cli-manager mirrors onto the session-host record meta. Those auto-launched workers
// stay idle-LIVE after their turn, so repeated reviews pile up idle sessions.
//
// SAFETY: we compute the cleanup target set ONLY from the replica queue tasks themselves —
// each replica contributes ITS OWN session ids (autoLaunch.sessionId once the auto-launch
// completed, and assignedSessionId once it claimed), paired with the replica's task id as the
// expected autoLaunchedForQueueTaskId marker. We never enumerate arbitrary sessions. The
// daemon then double-checks the per-session marker (requireAutoLaunchedForTaskIds) before
// touching anything: a REUSED idle session carries no marker → preserved; the COORDINATOR
// session carries no marker → preserved; a session whose marker points at a DIFFERENT task
// (re-assignment skew) → preserved. So only the sessions THIS fan-out actually spawned are
// stopped+deleted. assignedSessionId is intentionally included even though it can be a reused
// session — the marker gate filters reused ones out; an auto-launched-then-claimed session
// has assignedSessionId === autoLaunch.sessionId and IS the one we want gone.

/** One candidate cleanup target: a session a replica may have auto-launched, with the
 *  replica's task id that the session-host record marker must match for it to be cleaned. */
export interface MagiCleanupCandidate {
    nodeId: string;
    sessionId: string;
    /** The replica task id this session must have been auto-launched FOR (marker check). */
    expectedTaskId: string;
}

/**
 * Pure: derive the per-node cleanup target set from the replica queue tasks. Returns a map
 * keyed by nodeId → { sessionIds, requireAutoLaunchedForTaskIds }. Session ids are pulled
 * ONLY from each replica task's own autoLaunch.sessionId (when status 'completed') and
 * assignedSessionId — never from an external session listing — and each id is paired with
 * THAT replica's task id as the expected marker (so a re-assignment skew can't smuggle in a
 * sibling's session). A replica with no resolvable node id or no candidate session is skipped.
 */
export function computeMagiCleanupTargets(replicaTasks: any[]): Map<string, {
    sessionIds: string[];
    requireAutoLaunchedForTaskIds: Record<string, string>;
}> {
    const byNode = new Map<string, { sessionIds: Set<string>; requireAutoLaunchedForTaskIds: Record<string, string> }>();
    for (const task of Array.isArray(replicaTasks) ? replicaTasks : []) {
        const replicaTaskId = readString(task?.id);
        if (!replicaTaskId) continue;
        const nodeId = readString(task?.assignedNodeId)
            || readString(task?.autoLaunch?.nodeId)
            || readString(task?.targetNodeId);
        if (!nodeId) continue;
        const candidateSessionIds: string[] = [];
        // The session the queue auto-launched for this replica (authoritative auto-launch id).
        if (readString(task?.autoLaunch?.status) === 'completed') {
            const al = readString(task?.autoLaunch?.sessionId);
            if (al) candidateSessionIds.push(al);
        }
        // The session that actually claimed/ran it. May equal the auto-launched id (then it's
        // the same session) or be a reused idle session (filtered out by the marker gate).
        const assigned = readString(task?.assignedSessionId);
        if (assigned) candidateSessionIds.push(assigned);
        if (candidateSessionIds.length === 0) continue;
        let entry = byNode.get(nodeId);
        if (!entry) {
            entry = { sessionIds: new Set<string>(), requireAutoLaunchedForTaskIds: {} };
            byNode.set(nodeId, entry);
        }
        for (const sid of candidateSessionIds) {
            entry.sessionIds.add(sid);
            // Pair each session id with THIS replica's task id. If two replicas somehow named
            // the same session id (shared-session collision), the marker on the live record can
            // only equal one task id, so at most one replica legitimately owns it; recording the
            // first is fine because the daemon re-verifies the marker == expectedTaskId per id.
            if (!(sid in entry.requireAutoLaunchedForTaskIds)) {
                entry.requireAutoLaunchedForTaskIds[sid] = replicaTaskId;
            }
        }
    }
    const out = new Map<string, { sessionIds: string[]; requireAutoLaunchedForTaskIds: Record<string, string> }>();
    for (const [nodeId, entry] of byNode) {
        out.set(nodeId, {
            sessionIds: Array.from(entry.sessionIds),
            requireAutoLaunchedForTaskIds: entry.requireAutoLaunchedForTaskIds,
        });
    }
    return out;
}

/**
 * Resolve whether MAGI post-review auto-cleanup is enabled for this call. Per-call
 * auto_cleanup override (boolean) beats the mesh policy (magiSessionCleanup), which
 * defaults ON ('stop_and_delete'). Returns the effective mode.
 */
export function resolveMagiAutoCleanupMode(
    ctx: MeshContext,
    perCallOverride: boolean | undefined,
): RepoMeshMagiSessionCleanupMode {
    if (perCallOverride === true) return 'stop_and_delete';
    if (perCallOverride === false) return 'preserve';
    return resolveMagiSessionCleanupMode((ctx.mesh as any)?.policy?.magiSessionCleanup);
}

/**
 * Best-effort post-review cleanup. Stops+deletes ONLY the worker sessions THIS MAGI fan-out
 * auto-launched (marker-verified daemon-side). Only runs when `terminal` is true — a partial
 * collect must NOT kill replicas that are still generating. Never throws: cleanup failure
 * never blocks returning the synthesis. Returns a small summary (or null when skipped/disabled).
 */
export async function cleanupMagiAutoLaunchedSessions(
    ctx: MeshContext,
    args: { replicaTasks: any[]; terminal: boolean; mode: RepoMeshMagiSessionCleanupMode },
): Promise<{ cleanedSessionCount: number; perNode: Array<Record<string, unknown>> } | null> {
    if (args.mode === 'preserve') return null;
    if (!args.terminal) return null; // never cleanup a partial collection — replicas may still be live
    const targets = computeMagiCleanupTargets(args.replicaTasks);
    if (targets.size === 0) return null;

    let cleanedSessionCount = 0;
    const perNode: Array<Record<string, unknown>> = [];
    // OFFLINE-NODE-BLOCKING: run the per-node cleanup fan-out concurrently with per-node
    // error isolation (Promise.allSettled) so one offline replica node no longer serializes
    // the rest. cleanup_mesh_sessions is a MUTATION (not a pure read), but it is idempotent
    // and safe to skip for an unreachable node — an offline replica has no live sessions we
    // could reach anyway. Stamp it with the status-origin marker ({ statusProbe: true }): the
    // marker is used ONLY to grant the daemon-cloud relay's SHORT connect-wait budget (so an
    // offline node fails fast in ~2s instead of the 90s connect deadline) and is stripped
    // before the command executes, so the server-side cleanup semantics are unchanged.
    const cleanupNode = async (
        nodeId: string,
        group: { sessionIds: string[]; requireAutoLaunchedForTaskIds?: unknown },
    ): Promise<{ cleaned: number; entry: Record<string, unknown> }> => {
        try {
            const node = await findOptionalNodeWithRefresh(ctx, nodeId);
            if (!node) {
                // Node gone from the live mesh — its sessions are unreachable; report, don't fail.
                return { cleaned: 0, entry: { nodeId, skipped: 'node_not_in_live_mesh', sessionIds: group.sessionIds } };
            }
            const result = await commandForNode(ctx, node, 'cleanup_mesh_sessions', {
                meshId: ctx.mesh.id,
                nodeId,
                mode: 'stop_and_delete',
                sessionIds: group.sessionIds,
                source: 'magi_session_cleanup',
                requireAutoLaunchedForTaskIds: group.requireAutoLaunchedForTaskIds,
                inlineMesh: ctx.mesh,
            }, { statusProbe: true });
            const payload = unwrapCommandPayload(result) as any;
            const deleted = Array.isArray(payload?.deletedSessionIds) ? payload.deletedSessionIds.length : 0;
            const stopped = Array.isArray(payload?.stoppedSessionIds) ? payload.stoppedSessionIds.length : 0;
            return {
                cleaned: deleted + stopped,
                entry: {
                    nodeId,
                    requested: group.sessionIds.length,
                    deleted,
                    ...(stopped ? { stopped } : {}),
                    ...(Array.isArray(payload?.skippedMarkerMismatchSessionIds) && payload.skippedMarkerMismatchSessionIds.length
                        ? { skippedMarkerMismatch: payload.skippedMarkerMismatchSessionIds }
                        : {}),
                    ...(payload?.deleteUnsupported ? { deleteUnsupported: true } : {}),
                },
            };
        } catch (e: any) {
            return { cleaned: 0, entry: { nodeId, error: e?.message || String(e), sessionIds: group.sessionIds } };
        }
    };

    const cleanupTargets = Array.from(targets).filter(([, group]) => group.sessionIds.length > 0);
    const settled = await Promise.allSettled(
        cleanupTargets.map(([nodeId, group]) => cleanupNode(nodeId, group)),
    );
    settled.forEach((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
            cleanedSessionCount += outcome.value.cleaned;
            perNode.push(outcome.value.entry);
        } else {
            // cleanupNode swallows its own errors, so a rejection here is unexpected.
            const [nodeId, group] = cleanupTargets[idx];
            perNode.push({ nodeId, error: outcome.reason?.message ?? String(outcome.reason), sessionIds: group.sessionIds });
        }
    });
    return { cleanedSessionCount, perNode };
}

/**
 * FIX#1 (MAGI tangle): is THIS replica's transcript session also bound to ANOTHER replica of
 * the same fan-out? collect used to resolve a replica's transcript purely by
 * task.assignedSessionId and parse the NEWEST kind-valid JSON across that whole session. But
 * assignedSessionId is NOT unique per replica — it is never cleared on completion, and a
 * provider can reuse one session for >1 replica (sequential idle→claim reuse). When two
 * replicas share a session both resolve to the SAME newest turn → one is dropped as
 * unparseable_output / mis-attributed. There is no per-bubble taskId in the transcript to
 * disambiguate them (the dispatch stamps meshContext.taskId, but bubbles carry only a
 * positional _turnKey, and every MAGI replica is sent the IDENTICAL prompt so the user-bubble
 * text can't separate them either). So we FAIL CLOSED on a detected share: the colliding
 * replica is not attributed the ambiguous turn — it re-waits, and at the deadline finalizes as
 * a `cross_wired_shared_session` error instead of returning another replica's answer.
 *
 * Session ids are node-local, so a match only collides on the SAME node; a coincidental id
 * match across two nodes is not a real share. Pure given a task snapshot.
 */
export function sessionSharedWithAnotherReplica(task: any, allTasks: any[]): boolean {
    const sid = readString(task?.assignedSessionId);
    if (!sid) return false;
    const nodeId = readString(task?.assignedNodeId);
    return (Array.isArray(allTasks) ? allTasks : []).some((other: any) => other?.id !== task?.id
        && readString(other?.assignedSessionId) === sid
        && (!nodeId || !readString(other?.assignedNodeId) || readString(other?.assignedNodeId) === nodeId));
}

/**
 * Classify which non-terminal replica tasks are STALE — assigned to a node/session
 * absent from the live mesh (so they will never reach a terminal state). Reuses the
 * shared queue staleness annotation (annotateQueueStaleness) so MAGI and the queue
 * tools agree on what "stale" means. Pure given tasks already annotated. Returns the
 * set of stale (won't-progress) non-terminal task ids and their reasons.
 */
export function classifyStaleReplicas(
    annotatedTasks: any[],
    terminal: Set<string> = MAGI_TERMINAL_STATUSES,
): { staleTaskIds: Set<string>; staleReasons: Record<string, string> } {
    const staleTaskIds = new Set<string>();
    const staleReasons: Record<string, string> = {};
    for (const t of Array.isArray(annotatedTasks) ? annotatedTasks : []) {
        if (terminal.has(String(t?.status))) continue;
        if (t?.staleAssigned === true) {
            const id = readString(t.id);
            if (!id) continue;
            staleTaskIds.add(id);
            staleReasons[id] = readString(t.staleReason) || 'assigned node/session is not present in the live mesh';
        }
    }
    return { staleTaskIds, staleReasons };
}

// ─── Persistence (deltaE) ───────────────────────

/**
 * Persist the MAGI fan-out as a `magi_dispatched` ledger entry so the consensus group
 * is visible in mesh_status (status=running) and survives a coordinator restart even
 * before any synthesis is collected. Best-effort — a ledger write failure never aborts
 * the review.
 */
function persistMagiDispatched(
    ctx: MeshContext,
    args: { consensusGroupId: string; missionId?: string; panel?: string; question?: string; replicaCount: number; taskKind?: MagiTaskKind },
): void {
    try {
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'magi_dispatched',
            payload: {
                source: 'magi',
                consensusGroupId: args.consensusGroupId,
                ...(args.missionId ? { missionId: args.missionId } : {}),
                ...(args.panel ? { panel: args.panel } : {}),
                ...(args.question ? { question: args.question.slice(0, 300) } : {}),
                replicaCount: args.replicaCount,
                // MAGI-REDESIGN: persist the task_kind so a later mesh_magi_collect
                // (which rediscovers replicas from the queue, not the original call)
                // re-derives the right schema parser for this group.
                ...(args.taskKind ? { taskKind: args.taskKind } : {}),
            },
        });
    } catch { /* ledger write is best-effort */ }
}

/**
 * Recover the task_kind a MAGI fan-out was dispatched with from its `magi_dispatched`
 * ledger entry (mesh_magi_collect rediscovers replicas from the queue and has no kind in
 * hand). Defaults to claim_audit (the backward-compatible kind) when no entry / no kind
 * is recorded. Best-effort: an unreadable ledger returns the default.
 */
function recoverMagiTaskKind(ctx: MeshContext, consensusGroupId: string): MagiTaskKind {
    try {
        const entries = readLedgerEntries(ctx.mesh.id, { kind: ['magi_dispatched'], tail: 200 });
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const payload = (entries[i] as any)?.payload;
            if (!payload || typeof payload !== 'object') continue;
            if (readString(payload.consensusGroupId) !== consensusGroupId) continue;
            return normalizeMagiTaskKind(payload.taskKind);
        }
    } catch { /* unreadable ledger → default kind */ }
    return DEFAULT_TASK_KIND;
}

/**
 * Strip per-replica rawAnswer (the captured raw end-user text) from a synthesis's
 * replicas[]. rawAnswer can be up to MAGI_RAW_ANSWER_CAP chars × N replicas, so it is
 * gated: omitted from the persisted ledger entry (bounds ledger payload growth) and from
 * the default mesh_magi_collect response. Returns a shallow copy with rawAnswer/
 * rawAnswerTruncated removed from every replica; the original is never mutated.
 */
function stripRawAnswers(synthesis: MagiSynthesis): MagiSynthesis {
    if (!Array.isArray(synthesis.replicas) || synthesis.replicas.length === 0) return synthesis;
    return {
        ...synthesis,
        replicas: synthesis.replicas.map(r => {
            if (r.rawAnswer === undefined && r.rawAnswerTruncated === undefined) return r;
            const { rawAnswer: _omitRaw, rawAnswerTruncated: _omitTrunc, ...rest } = r;
            return rest;
        }),
    };
}

/**
 * Persist the synthesis as a `magi_synthesis` ledger entry, retrievable by
 * consensusGroupId (getMeshMagiActivityByGroup) and foldable into mesh_status. The full
 * synthesis is stored MINUS per-replica rawAnswer (the caller strips it to bound ledger
 * payload growth); mesh_status bounds it further on read. Best-effort.
 */
function persistMagiSynthesis(
    ctx: MeshContext,
    args: { consensusGroupId: string; missionId?: string; panel?: string; question?: string; staleReplicas?: number; synthesis: MagiSynthesis },
): void {
    try {
        appendLedgerEntry(ctx.mesh.id, {
            kind: 'magi_synthesis',
            payload: {
                source: 'magi',
                consensusGroupId: args.consensusGroupId,
                ...(args.missionId ? { missionId: args.missionId } : {}),
                ...(args.panel ? { panel: args.panel } : {}),
                ...(args.question ? { question: args.question.slice(0, 300) } : {}),
                ...(typeof args.staleReplicas === 'number' ? { staleReplicas: args.staleReplicas } : {}),
                synthesis: args.synthesis,
            },
        });
    } catch { /* ledger write is best-effort */ }
}

/**
 * FIX#3 — auto-close the inline MAGI mission once all replicas are terminal.
 *
 * Every mesh_magi_review auto-creates an inline mission (status defaults 'active') for the
 * fan-out; nothing ever closed it, so 'MAGI: …' missions accumulated forever (mission status
 * is, by design, never derived from task status). Call this at the collect-terminal point:
 * when collection is terminal (all replicas reached a terminal verdict) and the synthesis has
 * been persisted, transition the OWNING mission active→completed.
 *
 * Guards:
 *  - (a) MAGI-owned only — the caller MUST pass the replica tasks' OWN missionId (never a
 *    coordinator-supplied id), so we only ever close the inline MAGI mission.
 *  - (b) Never clobber a manual terminal/paused status — upsertMeshMission has NO no-clobber
 *    semantics (it overwrites status), so we read the current status first and ONLY transition
 *    from 'active'. An 'abandoned'/'paused'/'completed' mission is left untouched.
 * Idempotent: a re-collect that finds the mission already 'completed' is a no-op. Best-effort:
 * a missing mission / read failure never breaks collection.
 */
function closeMagiMissionIfTerminal(ctx: MeshContext, missionId: string | undefined, terminal: boolean): void {
    if (!terminal) return;
    const id = readString(missionId);
    if (!id) return;
    try {
        const mission = getMeshMission(ctx.mesh.id, id);
        // Only close a mission we can see AND that is still active. Skip when missing
        // (already pruned), or already completed/abandoned/paused (guard b).
        if (!mission || mission.status !== 'active') return;
        upsertMeshMission(ctx.mesh.id, {
            id,
            title: mission.title,
            // Preserve goal: upsert defaults goal to the existing value when omitted.
            status: 'completed',
        });
    } catch { /* mission close is best-effort — never break collection */ }
}

/**
 * Pull a compact git ref off a live mesh node (its GitCompactSummary, populated by the
 * daemon git monitor) for deltaA git-skew. Returns undefined when the node carries no
 * git summary — refs are best-effort, never fabricated.
 */
function extractNodeGitRef(node: any): MagiReplicaGitRef | undefined {
    const git = node?.git;
    if (!git || typeof git !== 'object') return undefined;
    const ref: MagiReplicaGitRef = {};
    if (typeof git.branch === 'string' || git.branch === null) ref.branch = git.branch;
    const headCommit = nodeHeadCommit(node);
    if (headCommit) ref.headCommit = headCommit;
    if (typeof git.ahead === 'number' && Number.isFinite(git.ahead)) ref.ahead = git.ahead;
    if (typeof git.behind === 'number' && Number.isFinite(git.behind)) ref.behind = git.behind;
    if (typeof git.dirty === 'boolean') ref.dirty = git.dirty;
    return Object.keys(ref).length > 0 ? ref : undefined;
}

async function collectMagiResponses(
    ctx: MeshContext,
    args: { replicaTaskIds: string[]; timeoutMs: number; taskKind?: MagiTaskKind },
): Promise<{ responses: MagiSynthesizedResponse[]; terminal: boolean; timedOut: boolean; staleCount: number; retriedCount: number }> {
    const ids = new Set(args.replicaTaskIds);
    const deadline = Date.now() + args.timeoutMs;
    const TERMINAL = MAGI_TERMINAL_STATUSES;
    const kind = args.taskKind ?? DEFAULT_TASK_KIND;
    const emptyResponse = (): MagiAgentResponse => ({ claims: [], top_findings: [], open_questions: [] });

    // E: each replica gets at most ONE delta re-request when its terminal answer fails
    // the kind schema. We track which task ids have already been re-requested so a second
    // schema failure drops to unparseable (current behavior) instead of looping.
    const retried = new Set<string>();

    // Per-replica FINAL verdict, locked once reached: a parseable answer, a stale dead
    // assignment, a non-readable terminal, or (at deadline) an unparseable confirmation.
    // `provisional` keeps a parseable-but-WEAK answer as the deadline fallback so a re-wait
    // never loses a valid answer it already saw.
    const finalized = new Map<string, MagiSynthesizedResponse>();
    const provisional = new Map<string, MagiSynthesizedResponse>();

    // FIX C-rawanswer: capture the replica's raw end-user answer (newest readable
    // candidate text from its transcript), capped to MAGI_RAW_ANSWER_CAP so a long
    // answer can't bloat the synthesis payload / ledger. Returns undefined when no
    // readable text was produced. Gated downstream: stripped from the persisted
    // magi_synthesis ledger entry and the default mesh_magi_collect response; surfaced
    // only in mesh_magi_collect verbose.
    const captureRawAnswer = (source: MagiResponseSource, payload: unknown): void => {
        try {
            const candidates = collectMagiCandidateTexts(payload);
            const raw = candidates.find(c => c.trim().length > 0);
            if (!raw) return;
            if (raw.length > MAGI_RAW_ANSWER_CAP) {
                source.rawAnswer = raw.slice(0, MAGI_RAW_ANSWER_CAP);
                source.rawAnswerTruncated = true;
            } else {
                source.rawAnswer = raw;
            }
        } catch { /* raw-answer capture is best-effort */ }
    };

    const buildSource = (task: any): MagiResponseSource => {
        const sourceNodeId = task.assignedNodeId || task.targetNodeId || undefined;
        // deltaA: capture the replica node's git ref so synthesis can flag cross-replica
        // git skew. Best-effort, from the live node's compact git summary.
        const gitRef = extractNodeGitRef(sourceNodeId ? ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, sourceNodeId)) : undefined);
        return {
            taskId: task.id,
            nodeId: sourceNodeId,
            provider: task.assignedProviderType || undefined,
            ok: false,
            ...(gitRef ? { git: gitRef } : {}),
        };
    };

    // E: send ONE delta re-request to a replica whose terminal answer failed the kind
    // schema, asking for a single JSON matching exactly that kind's contract. Best-effort —
    // a send failure leaves the replica to be finalized as unparseable at the deadline. The
    // replica stays `completed`; the new turn flips it back to generating, so the poll loop
    // re-reads it naturally. Returns true when the delta was dispatched.
    const sendKindRetry = async (task: any, failReason: MagiKindParseResult['failReason']): Promise<boolean> => {
        const node = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, task.assignedNodeId));
        if (!node || !task.assignedSessionId) return false;
        const why = failReason === 'empty_evidence'
            ? 'your previous answer had an empty evidence array'
            : failReason === 'missing_required_fields'
                ? 'your previous answer was missing required fields'
                : 'your previous answer did not parse as the required JSON';
        const message = `Your previous MAGI answer could not be accepted (${why}). Respond NOW with ONLY a single JSON object (no prose, no code fence) matching EXACTLY this schema, with non-empty evidence:\n\n${magiOutputContractFor(kind)}`;
        try {
            const coordinatorDaemonId = ctx.localDaemonId;
            await commandForNode(ctx, node, 'agent_command', {
                targetSessionId: task.assignedSessionId,
                providerType: task.assignedProviderType,
                cliType: task.assignedProviderType,
                agentType: task.assignedProviderType,
                action: 'send_chat',
                message,
                // DISPATCH-SOURCE-TRACE: call-site tag echoed in the worker daemon log.
                dispatchSource: 'mesh-tools-magi:sendKindRetry',
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: task.assignedNodeId,
                    taskId: task.id,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                    ...(ctx.coordinatorSessionId ? { coordinatorSessionId: ctx.coordinatorSessionId } : {}),
                },
            });
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'magi_replica_retry' as any,
                    payload: { taskId: task.id, kind, failReason },
                });
            } catch { /* ledger write is best-effort */ }
            return true;
        } catch { return false; }
    };

    // Recover a replica wedged on an approval modal. A MAGI replica is dispatched
    // readonly:true, so any command-approval prompt it raises (typically the git/read it runs
    // to gather file:line evidence) is safe to approve — and MUST be, because dispatch-time
    // auto-approve is not guaranteed (IDE providers with no resolveAction script no-op it;
    // remote pre-existing sessions never get the autoApprove backfill). Left unresolved, the
    // replica burns the whole collect deadline and is lost as `replica_waiting_approval`.
    // Reads the live session; only approves when it is actually in an approval state. Idempotent
    // — resolve_action reports already_resolved/stale_prompt within its cooldown, so re-calling
    // on later poll ticks is a no-op. Fully best-effort: any failure just leaves the normal
    // re-wait/deadline path intact. Emits one ledger breadcrumb per approval attempt.
    const nudgeWedgedReplica = async (task: any): Promise<void> => {
        const node = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, task.assignedNodeId));
        if (!node || !task.assignedSessionId) return;
        try {
            // ── §8 unit 8: replica hop (design §4 roster id 7) ──────────────
            // `magi_approval_probe`. Only `status` + `activeModal` are read, and
            // the SAME magiReadIndicatesApprovalWedge predicate decides — so
            // approve idempotency is untouched by the source swap.
            //
            // ★ Freshness is mandatory here and the reason is not cosmetic: a
            // stale snapshot describes a modal that may already be gone, and
            // this consumer's next act is an approve CLICK. Any coverage is
            // accepted (even `tail`) because the two fields are session-level,
            // not message-window-derived. resolve_action below stays a live RPC
            // regardless — the replica decides only WHETHER to act, never
            // performs the act.
            const replicaTransport = resolveSemanticReplicaTransport(ctx, node as any);
            let payload: any = null;
            if (replicaTransport) {
                const replica = await readTranscriptReplicaForSemanticConsumer(replicaTransport, {
                    consumerId: 'magi_approval_probe',
                    ownerDaemonId: (node as any).daemonId,
                    rawSessionId: task.assignedSessionId,
                    acceptCoverage: ['full', 'tail', 'current-turn'],
                    requireFresh: true,
                });
                if (replica.payload) payload = replica.payload;
            }
            if (!payload) {
                const read = await commandForNode(ctx, node, 'read_chat', {
                    sessionId: task.assignedSessionId,
                    targetSessionId: task.assignedSessionId,
                    workspace: (node as any).workspace,
                    tailLimit: 1,
                });
                payload = unwrapCommandPayload(read) as any;
            }
            if (!magiReadIndicatesApprovalWedge(payload)) return;
            const status = String(payload?.status ?? '');
            await commandForNode(ctx, node, 'resolve_action', {
                sessionId: task.assignedSessionId,
                targetSessionId: task.assignedSessionId,
                workspace: (node as any).workspace,
                providerType: task.assignedProviderType,
                agentType: task.assignedProviderType,
                cliType: task.assignedProviderType,
                action: 'approve',
            });
            try {
                appendLedgerEntry(ctx.mesh.id, {
                    kind: 'magi_replica_auto_approved' as any,
                    payload: { taskId: task.id, nodeId: task.assignedNodeId, status },
                });
            } catch { /* ledger write is best-effort */ }
        } catch { /* nudge is best-effort — fall through to the normal re-wait */ }
    };

    // Attempt to FINALIZE one replica from its current state. Returns true once a final
    // verdict is locked. `force` (deadline reached / tasks gone) converts any remaining
    // re-wait (weak/unparseable/still-running) into a terminal verdict.
    const tryResolveReplica = async (
        task: any,
        staleTaskIds: Set<string>,
        staleReasons: Record<string, string>,
        force: boolean,
        liveTasks: any[],
    ): Promise<boolean> => {
        const taskId = task.id;
        const source = buildSource(task);

        // Not a readable completion yet (failed/cancelled/running, or no session bound).
        if (task.status !== 'completed' || !task.assignedNodeId || !task.assignedSessionId) {
            if (staleTaskIds.has(taskId)) {
                source.stale = true;
                source.error = `stale: ${staleReasons[taskId]}`;
                finalized.set(taskId, { source, response: emptyResponse() });
                return true;
            }
            if (TERMINAL.has(String(task.status))) {
                source.error = task.status === 'completed' ? 'no_session_to_read' : `replica_${task.status || 'incomplete'}`;
                finalized.set(taskId, { source, response: emptyResponse() });
                return true;
            }
            // Still running and not stale. A replica can WEDGE here forever on an approval
            // modal: a MAGI task is dispatched read-only, but dispatch-time auto-approve is
            // conditional (it no-ops for an IDE provider whose auto-approve script is absent,
            // or a remote pre-existing session that never got the autoApprove backfill), so a
            // command-approval prompt (e.g. the git-read the replica runs to gather evidence)
            // is never clicked and the replica is silently lost at the collect deadline as
            // `replica_waiting_approval`. Because the MAGI task is readonly:true, approving is
            // exactly the intended semantics — so before re-waiting, detect a bound-session
            // approval wedge and drive resolve_action(approve) on it. Best-effort and idempotent
            // (a stale/already-resolved prompt is a no-op); provider-agnostic (recovers both the
            // IDE-provider and remote-adopt gaps). Skipped under `force` (the deadline pass just
            // finalizes) and rate-limited to once per replica per poll tick.
            if (task.assignedNodeId && task.assignedSessionId && !force) {
                await nudgeWedgedReplica(task);
            }
            if (force) {
                source.error = `replica_${task.status || 'incomplete'}`;
                finalized.set(taskId, { source, response: emptyResponse() });
                return true;
            }
            return false;
        }

        // FIX#1: cross-wire guard. This completed replica's session is also bound to another
        // replica of THIS group → the newest turn cannot be safely attributed to either. Do NOT
        // grab it (that is exactly the mis-attribution / dropped-as-unparseable bug). Re-wait so a
        // later poll can find them on distinct sessions; at the deadline finalize as a cross-wire
        // error (not another replica's answer).
        if (sessionSharedWithAnotherReplica(task, liveTasks)) {
            if (force) {
                source.error = 'cross_wired_shared_session';
                finalized.set(taskId, { source, response: emptyResponse() });
                return true;
            }
            return false;
        }

        // A `completed` replica WITH a session: read the transcript and try to parse a MAGI
        // answer for THIS kind. Fix A: a completed-but-weak completion (early/mid-turn
        // suppressed) or a not-yet-parseable transcript is treated as NOT terminal — re-poll
        // until the deadline rather than collecting a premature mid-turn bubble.
        let kindResult: MagiKindParseResult;
        try {
            const node = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, task.assignedNodeId));
            if (!node) throw new Error('assigned node not in mesh');
            // ── §8 unit 8: replica hop (design §4 roster id 8) ──────────────
            // `magi_result_collect`. The replica payload is fed to the SAME
            // captureRawAnswer + parseFirstMagiCandidateForKind below, so the
            // weak/unparseable/retry/deadline semantics are all unchanged.
            //
            // ★ ONLY current-turn coverage is admitted, and that is the whole
            // FIX#1 guard restated: the live read below asks for
            // coverage:'current-turn' precisely because a whole-session tail's
            // newest kind-valid JSON can belong to an EARLIER turn and be
            // mis-attributed as this replica's answer. A `tail`-covered replica
            // snapshot is that same hazard arriving by a different road, so it
            // declines to legacy rather than being parsed. Freshness is
            // required because this read locks a terminal verdict.
            const replicaTransport = resolveSemanticReplicaTransport(ctx, node as any);
            let payload: any = null;
            if (replicaTransport) {
                const replica = await readTranscriptReplicaForSemanticConsumer(replicaTransport, {
                    consumerId: 'magi_result_collect',
                    ownerDaemonId: (node as any).daemonId,
                    rawSessionId: task.assignedSessionId,
                    acceptCoverage: ['current-turn'],
                    requireFresh: true,
                });
                if (replica.payload) payload = replica.payload;
            }
            if (!payload) {
                const result = await commandForNode(ctx, node, 'read_chat', {
                    sessionId: task.assignedSessionId,
                    targetSessionId: task.assignedSessionId,
                    workspace: (node as any).workspace,
                    tailLimit: 6,
                    // FIX#1: scope the read to the CURRENT turn so a provider that supports it returns
                    // only this turn's bubbles (coverage:'current-turn' / _turnKey), instead of the
                    // whole-session tail whose newest kind-valid JSON could belong to an earlier turn.
                    coverage: 'current-turn',
                });
                payload = unwrapCommandPayload(result);
            }
            // Capture the raw answer onto `source` now, so it rides along whether this
            // replica finalizes as a parseable answer or a weak/provisional one. (Stripped
            // for non-verbose consumers downstream.)
            captureRawAnswer(source, payload);
            // Fix-A-v2 summary-fallback (kind-aware): parse candidates from BOTH the raw payload
            // (newest bubble body first, premature-collect guard) AND the compacted payload
            // (surfaces the lifted `summary` so antigravity's empty-bubble / summary-only answer
            // is recovered), validating each against the selected kind's schema.
            kindResult = parseFirstMagiCandidateForKind(payload, kind, {
                sessionId: task.assignedSessionId,
            });
        } catch (e: any) {
            // A transient read failure re-waits (the node/peer may be momentarily busy);
            // finalize the failure only once the deadline is hit.
            if (force) {
                source.error = `read_failed: ${e?.message || String(e)}`;
                finalized.set(taskId, { source, response: emptyResponse() });
                return true;
            }
            return false;
        }

        if (kindResult.ok && kindResult.response) {
            const weak = replicaCompletionIsWeak(ctx.mesh.id, taskId);
            if (weak && !force) {
                // Parseable but the completion evidence is weak — keep it as the deadline
                // fallback and re-wait for a stronger/fuller final answer.
                provisional.set(taskId, { source: { ...source, ok: true }, response: kindResult.response });
                return false;
            }
            finalized.set(taskId, { source: { ...source, ok: true }, response: kindResult.response });
            return true;
        }

        // Parsed something but it FAILS the kind schema (missing fields / empty evidence) →
        // E: fire exactly one delta re-request, then re-wait for the corrected answer. A
        // second failure (already retried) drops to unparseable below.
        const isSchemaFailure = kindResult.failReason === 'missing_required_fields'
            || kindResult.failReason === 'empty_evidence';
        if (isSchemaFailure && !retried.has(taskId) && !force) {
            retried.add(taskId);
            const sent = await sendKindRetry(task, kindResult.failReason);
            if (sent) return false; // re-wait for the corrected turn
            // Could not dispatch the retry → fall through to the unparseable handling.
        }

        // Not parseable / still schema-invalid → the premature-collect guard: re-wait until
        // the deadline, then finalize (preferring any provisional answer).
        if (force) {
            const prov = provisional.get(taskId);
            if (prov) {
                finalized.set(taskId, prov);
                return true;
            }
            // MAGI-DEADLINE-MISLABEL: `no_parseable_output` at the force-finalize pass means
            // "no valid JSON was EVER seen across every poll up to the deadline" — which is
            // indistinguishable, from inside this function, from "the replica simply hadn't
            // finished answering yet". A live 3-replica fan-out measured exactly this: kimi's
            // task was `completed` well before the (then 180s) deadline, every poll up to the
            // deadline read no parseable JSON in its transcript, and it was labeled
            // `unparseable_output` — reading as "kimi produced invalid output". 13 minutes
            // later kimi actually answered with a fully-evidenced rootCause JSON, proving the
            // label was wrong: it wasn't a bad answer, it just hadn't arrived. The coordinator
            // then misreported "0 valid replicas" instead of "no answer within the deadline".
            //
            // `schema_invalid:*` (isSchemaFailure) is left untouched — that case DID observe
            // real content (a parsed JSON object) that fails the kind schema after one retry,
            // which is a genuine content defect, not a timing artifact.
            source.error = isSchemaFailure ? `schema_invalid: ${kindResult.failReason}` : 'replica_deadline_exceeded';
            finalized.set(taskId, { source, response: emptyResponse() });
            return true;
        }
        return false;
    };

    // Poll until every replica reaches a final verdict, every still-outstanding replica is
    // detected STALE (dead assignment), or the deadline elapses.
    for (;;) {
        const tasks = annotateQueueStaleness(getQueue(ctx.mesh.id).filter((t: any) => ids.has(t.id)), ctx.mesh);
        const allPresent = tasks.length === ids.size;
        const { staleTaskIds, staleReasons } = classifyStaleReplicas(tasks, TERMINAL);
        const pastDeadline = Date.now() >= deadline;

        for (const task of tasks as any[]) {
            if (finalized.has(task.id)) continue;
            await tryResolveReplica(task, staleTaskIds, staleReasons, pastDeadline, tasks);
        }

        if (allPresent && finalized.size >= ids.size) break;
        if (pastDeadline) break;
        // Every still-outstanding replica is stale → stop early (they were just finalized above).
        const outstanding = tasks.filter((t: any) => !finalized.has(t.id));
        if (allPresent && outstanding.length > 0 && outstanding.every((t: any) => staleTaskIds.has(t.id))) break;

        await sleep(Math.min(MAGI_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    // Final pass: force-finalize anything still outstanding now that the loop has ended.
    const finalTasks = annotateQueueStaleness(getQueue(ctx.mesh.id).filter((t: any) => ids.has(t.id)), ctx.mesh);
    const { staleTaskIds, staleReasons } = classifyStaleReplicas(finalTasks, TERMINAL);
    const presentIds = new Set(finalTasks.map((t: any) => t.id));
    for (const task of finalTasks as any[]) {
        if (!finalized.has(task.id)) await tryResolveReplica(task, staleTaskIds, staleReasons, true, finalTasks);
    }
    // A replica whose queue row vanished entirely (never observed) is recorded as missing.
    for (const id of ids) {
        if (finalized.has(id)) continue;
        if (!presentIds.has(id)) {
            finalized.set(id, { source: { taskId: id, ok: false, error: 'replica_missing' }, response: emptyResponse() });
        }
    }

    // Preserve the caller's replica order.
    const responses = args.replicaTaskIds
        .map(id => finalized.get(id))
        .filter((r): r is MagiSynthesizedResponse => !!r);
    const terminal = presentIds.size === ids.size && finalTasks.every((t: any) => TERMINAL.has(String(t.status)));
    const staleCount = responses.filter(r => r.source.stale === true).length;
    return { responses, terminal, timedOut: !terminal, staleCount, retriedCount: retried.size };
}
