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
    getMagiPanel,
    getMeshMission,
    getQueue,
    isWeakCompletionEvidence,
    listMagiPanels,
    meshNodeIdMatches,
    nodeSatisfiesRequiredTags,
    normalizeMagiPanel,
    normalizeMeshCapabilityTags,
    randomUUID,
    readLedgerEntries,
    readString,
    refreshMeshFromDaemon,
    resolveCoordinatorNode,
    triggerMeshQueueAndReport,
    unwrapCommandPayload,
    upsertMagiPanel,
    upsertMeshMission,
} from './mesh-tools-internal.js';
import type {
    LocalMeshEntry,
    LocalMeshNodeEntry,
    MagiAgentResponse,
    MagiClaim,
    MagiClaimCluster,
    MagiClusterMember,
    MagiGitSkew,
    MagiMode,
    MagiPanel,
    MagiPanelMember,
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
/** Default wall-clock budget for wait=true replica collection. */
const MAGI_DEFAULT_WAIT_MS = 180_000;
const MAGI_MAX_WAIT_MS = 600_000;
const MAGI_POLL_INTERVAL_MS = 5_000;

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

export type MagiTaskKind = 'claim_audit' | 'rca' | 'design' | 'freeform';

const VALID_TASK_KINDS: readonly MagiTaskKind[] = ['claim_audit', 'rca', 'design', 'freeform'];
const DEFAULT_TASK_KIND: MagiTaskKind = 'claim_audit';

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
        independenceBanner = `independence not achieved — the answering replicas span ${distinctProviders} provider(s) and ${distinctNodes} machine(s); their agreements are source-coupled and routed to needs_verification.`;
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
    memberIndex: number;
    provider: string;
    /** Resolved concrete node id (pinned member), else undefined (tag-routed). */
    targetNodeId?: string;
    capabilityTags: string[];
    /** Tags the enqueued task hard-filters on: ['provider=<p>', ...capabilityTags]. */
    requiredTags: string[];
}

export interface MagiUnavailableMember {
    memberIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    reason: string;
}

/** Per-member resolution detail (for mesh_magi_panel_list + the git-stale exclusion). */
export interface MagiMemberResolution {
    memberIndex: number;
    provider: string;
    nodeId?: string;
    capabilityTags: string[];
    /** Resolves to ≥1 live node (pinned present, or a tag match). */
    available: boolean;
    /** Representative resolved node HEAD commit (best-effort; absent when unknown). */
    headCommit?: string;
    /** True when available AND every candidate node's known HEAD differs from referenceCommit. */
    gitStale: boolean;
    /** Excluded from the fan-out (unavailable, or git-stale and not include_stale). */
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
    unavailableMembers: MagiUnavailableMember[];
    /** The commit the panel is being resolved against (coordinator HEAD); undefined when unknown. */
    referenceCommit?: string;
    /** Per-member resolution detail, aligned to panel.members order. */
    memberResolutions: MagiMemberResolution[];
    /** Members excluded because they are git-stale (different HEAD) and include_stale was not set. */
    staleMembers: MagiMemberResolution[];
    /** Git-stale members that were nonetheless INCLUDED because include_stale=true (warning surface). */
    includedStaleMembers: MagiMemberResolution[];
}

function replicaCountFor(member: MagiPanelMember, panel: MagiPanel, globalN?: number): number {
    const n = member.n ?? panel.defaultN ?? globalN ?? 1;
    return Math.max(1, Math.floor(n));
}

/** Best-effort HEAD commit sha off a live node's git status (GitRepoStatus.headCommit). */
function nodeHeadCommit(node: any): string | undefined {
    const h = node?.git?.headCommit;
    return typeof h === 'string' && h.trim() ? h.trim() : undefined;
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
 * Resolve a panel against the live mesh nodes into a concrete fan-out plan:
 * expand each available member to its replica count, clamp the total to the guard
 * cap (drop logged, never silent), assess (node, provider) target diversity, and
 * flag a panel that collapses to a single provider/machine. Pure.
 */
export function buildMagiFanoutPlan(
    panel: MagiPanel,
    nodes: LocalMeshNodeEntry[],
    opts: { n?: number; maxReplicas?: number; referenceCommit?: string; includeStale?: boolean } = {},
): MagiFanoutPlan {
    const cap = Math.max(1, Math.floor(opts.maxReplicas ?? MAGI_MAX_REPLICAS));
    const members = Array.isArray(panel.members) ? panel.members : [];
    const referenceCommit = typeof opts.referenceCommit === 'string' && opts.referenceCommit.trim() ? opts.referenceCommit.trim() : undefined;
    const includeStale = opts.includeStale === true;
    const replicas: MagiReplicaPlan[] = [];
    const unavailableMembers: MagiUnavailableMember[] = [];
    const memberResolutions: MagiMemberResolution[] = [];
    const targetKeys = new Set<string>();
    const providerSet = new Set<string>();
    const nodeTargetSet = new Set<string>();
    let totalRequested = 0;

    members.forEach((member, memberIndex) => {
        const provider = member.provider;
        const capabilityTags = normalizeMeshCapabilityTags(member.capabilityTags);
        const requiredTags = normalizeMeshCapabilityTags([`provider=${provider}`, ...capabilityTags]);
        const count = replicaCountFor(member, panel, opts.n);

        // Resolve availability against the mesh, and gather the candidate node(s) so we
        // can assess git staleness against the reference commit.
        let targetNodeId: string | undefined;
        let candidateNodes: any[] = [];
        if (member.nodeId) {
            const node = nodes.find(n => meshNodeIdMatches(n as any, member.nodeId!));
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
            unavailableMembers.push({
                memberIndex,
                provider,
                nodeId: member.nodeId,
                capabilityTags,
                reason: member.nodeId
                    ? `pinned node '${member.nodeId}' is not a member of this mesh`
                    : `no mesh node satisfies required tags [${requiredTags.join(', ')}]`,
            });
            memberResolutions.push({ memberIndex, provider, nodeId: member.nodeId, capabilityTags, available: false, gitStale: false, excluded: true, reason: 'unavailable' });
            return;
        }

        // Git staleness vs the reference commit. A member is git-stale only when a
        // reference commit is known AND every candidate node with a known HEAD differs
        // from it (a node with no known HEAD can't be proven stale → treated as fresh,
        // so we never silently exclude on missing telemetry). Prefer routing to a fresh
        // candidate when one exists.
        let headCommit: string | undefined;
        let gitStale = false;
        if (referenceCommit) {
            const freshCandidate = candidateNodes.find(n => {
                const h = nodeHeadCommit(n);
                return !h || h === referenceCommit;
            });
            if (freshCandidate) {
                headCommit = nodeHeadCommit(freshCandidate);
                if (member.nodeId) targetNodeId = (freshCandidate as any).id;
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
            // candidate reports drift, mark the member git-stale (default-excluded like the
            // HEAD-diff path). A candidate with no drift telemetry at all is still treated as
            // fresh — we never exclude on missing data.
            const freshCandidate = candidateNodes.find(n => !nodeHasGitDrift(n));
            if (freshCandidate && candidateNodes.some(nodeHasGitDrift)) {
                // Mixed pool: route to the clean candidate, leave the member fresh.
                headCommit = nodeHeadCommit(freshCandidate);
                if (member.nodeId) targetNodeId = (freshCandidate as any).id;
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

        const resolution: MagiMemberResolution = {
            memberIndex,
            provider,
            nodeId: targetNodeId ?? member.nodeId,
            capabilityTags,
            available: true,
            ...(headCommit ? { headCommit } : {}),
            gitStale,
            excluded: false,
        };

        // Default-exclude a git-stale member (it would investigate different code than
        // the reference); include_stale=true overrides but the caller surfaces a warning.
        if (gitStale && !includeStale) {
            resolution.excluded = true;
            resolution.reason = referenceCommit
                ? `git-stale: node HEAD ${headCommit ?? '(unknown)'} differs from reference ${referenceCommit}`
                : `git-stale: node reports drift from its upstream (behind/ahead) and no coordinator reference commit is known`;
            memberResolutions.push(resolution);
            return;
        }

        totalRequested += count;
        const targetKey = targetNodeId ? `node:${targetNodeId}` : `tags:${[...requiredTags].sort().join(',')}`;
        targetKeys.add(`${targetKey}|${provider}`);
        providerSet.add(provider);
        nodeTargetSet.add(targetKey);
        memberResolutions.push(resolution);
        for (let i = 0; i < count; i++) {
            replicas.push({ memberIndex, provider, targetNodeId, capabilityTags, requiredTags });
        }
    });

    // Clamp to the guard cap (drop the tail; the caller logs the drop).
    const droppedReplicas = Math.max(0, replicas.length - cap);
    const capped = droppedReplicas > 0 ? replicas.slice(0, cap) : replicas;

    const distinctProviders = providerSet.size;
    const distinctNodeTargets = nodeTargetSet.size;
    // enoughTargets / coupled are computed over INCLUDED targets only — i.e. AFTER the
    // git-stale exclusion — so the ≥2-independent-target guard re-checks post-exclusion
    // and never silently degrades to N=1.
    const staleMembers = memberResolutions.filter(m => m.gitStale && m.excluded);
    const includedStaleMembers = memberResolutions.filter(m => m.gitStale && !m.excluded);
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
        unavailableMembers,
        ...(referenceCommit ? { referenceCommit } : {}),
        memberResolutions,
        staleMembers,
        includedStaleMembers,
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

export async function meshMagiPanelSet(
    ctx: MeshContext,
    args: { panel_name?: string; panelName?: string; config?: unknown; write?: boolean; overwrite?: boolean },
): Promise<string> {
    const panelName = readString(args.panel_name) || readString(args.panelName);
    if (!panelName) return JSON.stringify({ success: false, error: 'panel_name required' });
    const write = args.write === true;
    try {
        if (!write) {
            // Dry-run: normalize + validate via a throwaway upsert path WITHOUT persisting.
            // We re-use the same validation by constructing the normalized panel through
            // the accessor only on write; for dry-run we validate shape inline here.
            const preview = previewMagiPanel(args.config);
            return JSON.stringify({
                success: true,
                dryRun: true,
                panelName,
                panel: preview,
                note: 'Dry-run only — no file written. Re-run with write=true to persist to ~/.adhdev/meshes.json.',
            }, null, 2);
        }
        const panel = upsertMagiPanel(panelName, args.config, { overwrite: args.overwrite === true });
        return JSON.stringify({
            success: true,
            written: true,
            panelName,
            panel,
            nextAction: 'Verify resolution with mesh_magi_panel_list, then invoke mesh_magi_review({ panel, question, target }).',
        }, null, 2);
    } catch (e: any) {
        const message = e?.message || String(e);
        const code = message.includes('magi_panel_exists') ? 'magi_panel_exists'
            : message.includes('invalid_magi_panel') ? 'invalid_magi_panel'
            : undefined;
        return JSON.stringify({ success: false, ...(code ? { code } : {}), error: message });
    }
}

/**
 * Validate + normalize a panel config for dry-run preview. Delegates to the single
 * source-of-truth normalizer (daemon-core normalizeMagiPanel) so dry-run preview,
 * persisted upsert, and the inline-member ad-hoc path all share identical validation
 * (provider required, tag dedup, replica clamp, member cap) — no duplicated rules.
 */
function previewMagiPanel(config: unknown): MagiPanel {
    return normalizeMagiPanel(config);
}

/**
 * Build a one-off ad-hoc MAGI panel from inline `members` (mesh_magi_review members
 * override) WITHOUT persisting anything to meshes.json. Same member shape and same
 * normalizer as a named panel, so an inline panel resolves through the identical
 * fan-out / synthesis pipeline. Pure. Throws invalid_magi_panel on a malformed list.
 */
export function buildInlineMagiPanel(members: unknown, opts: { defaultN?: number; description?: string } = {}): MagiPanel {
    return normalizeMagiPanel({
        members,
        ...(opts.defaultN !== undefined ? { defaultN: opts.defaultN } : {}),
        description: opts.description ?? 'inline ad-hoc panel',
    });
}

export async function meshMagiPanelList(
    ctx: MeshContext,
    args: { panel?: string } = {},
): Promise<string> {
    await refreshMeshFromDaemon(ctx);
    const all = listMagiPanels();
    const only = readString(args.panel);
    const names = only ? (all[only] ? [only] : []) : Object.keys(all);
    if (only && names.length === 0) {
        return JSON.stringify({ success: false, code: 'magi_panel_not_found', error: `panel '${only}' is not configured`, configuredPanels: Object.keys(all) });
    }
    const referenceCommit = resolveMagiReferenceCommit(ctx);
    const panels = names.map(name => {
        const panel = all[name];
        // Resolve with the reference commit so the listing reflects which members are
        // git-stale and would be excluded by default (panel_list itself never dispatches).
        const plan = buildMagiFanoutPlan(panel, ctx.mesh.nodes, { referenceCommit });
        return {
            name,
            description: panel.description,
            // Per-member gitStale boolean alongside the raw member definition.
            members: panel.members.map((m, i) => {
                const res = plan.memberResolutions.find(r => r.memberIndex === i);
                return {
                    ...m,
                    gitStale: res?.gitStale === true,
                    ...(res?.headCommit ? { headCommit: res.headCommit } : {}),
                };
            }),
            defaultN: panel.defaultN ?? 1,
            resolution: {
                referenceCommit: referenceCommit ?? null,
                totalReplicas: plan.totalAfterCap,
                distinctTargets: plan.distinctTargets,
                distinctProviders: plan.distinctProviders,
                distinctMachines: plan.distinctNodeTargets,
                enoughTargets: plan.enoughTargets,
                coupled: plan.coupled,
                unavailableMembers: plan.unavailableMembers,
                staleMembers: plan.staleMembers,
            },
            ...(plan.staleMembers.length > 0 ? { gitStaleWarning: `${plan.staleMembers.length} member(s) are git-stale (HEAD differs from reference ${referenceCommit ?? '(unknown)'}) and are excluded by default; pass include_stale=true to mesh_magi_review to include them.` } : {}),
            ...(plan.coupled ? { warning: 'This panel collapses to a single provider or single machine — its agreements would be flagged source-coupled.' } : {}),
            ...(!plan.enoughTargets ? { error: `Resolves to ${plan.distinctTargets} distinct (node, provider) target(s) after git-stale exclusion; MAGI requires ≥${MAGI_MIN_TARGETS}.` } : {}),
        };
    });
    return JSON.stringify({ success: true, count: panels.length, ...(referenceCommit ? { referenceCommit } : {}), panels }, null, 2);
}

export async function meshMagiReview(
    ctx: MeshContext,
    args: {
        question?: string;
        target?: string;
        artifacts?: string[];
        panel?: string;
        members?: unknown;
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
        use_judge?: boolean;
        useJudge?: boolean;
    },
): Promise<string> {
    const question = readString(args.question);
    if (!question) return JSON.stringify({ success: false, error: 'question required' });

    // MAGI-REDESIGN: select the output kind (default claim_audit for backward compat).
    const taskKind = normalizeMagiTaskKind(args.task_kind ?? args.taskKind);
    // B: warn (do NOT block) if the coordinator embedded an output schema in the question —
    // it collides with the single kind contract MAGI injects and causes fusion/unparseable.
    const questionSchemaWarning = detectQuestionOutputSchemaConflict(question);
    // G: use_judge is an interface stub only — judge synthesis is not implemented; true
    // falls back to clustering with a warning. Default false.
    const useJudge = (args.use_judge ?? args.useJudge) === true;
    const judgeWarning = useJudge
        ? 'use_judge=true requested, but judge synthesis is not yet implemented — falling back to clustering synthesis.'
        : null;

    await refreshMeshFromDaemon(ctx);

    // 1. Resolve the panel. Inline `members` take precedence (ad-hoc panel, not
    // persisted); otherwise look up the named panel (falling back to "default").
    const hasInlineMembers = Array.isArray(args.members) && args.members.length > 0;
    let panel: MagiPanel | undefined;
    let panelName: string;
    if (hasInlineMembers) {
        panelName = '(inline)';
        try {
            panel = buildInlineMagiPanel(args.members, { defaultN: args.n });
        } catch (e: any) {
            return JSON.stringify({
                success: false,
                code: 'invalid_magi_panel',
                error: e?.message || String(e),
                hint: 'Inline members use the same shape as a configured panel: [{ provider (REQUIRED), nodeId?, capabilityTags?, n? }].',
            });
        }
    } else {
        panelName = readString(args.panel) || 'default';
        panel = getMagiPanel(panelName);
    }
    if (!panel) {
        return JSON.stringify({
            success: false,
            code: 'magi_panel_missing',
            error: `MAGI panel '${panelName}' is not configured. Define it first with mesh_magi_panel_set, pass inline members, and inspect resolution with mesh_magi_panel_list.`,
            configuredPanels: Object.keys(listMagiPanels()),
        });
    }

    // 2. Plan the fan-out. Git-stale members (node HEAD differs from the coordinator's
    // reference commit) are EXCLUDED by default — they would investigate different code;
    // include_stale=true keeps them (with a warning). The ≥2-target guard below is
    // re-checked AFTER this exclusion, so it never silently degrades to N=1.
    const includeStale = (args.include_stale ?? args.includeStale) === true;
    const referenceCommit = resolveMagiReferenceCommit(ctx);
    const plan = buildMagiFanoutPlan(panel, ctx.mesh.nodes, { n: args.n, referenceCommit, includeStale });
    if (!plan.enoughTargets) {
        const droppedByStale = plan.staleMembers.length > 0;
        return JSON.stringify({
            success: false,
            code: droppedByStale ? 'magi_insufficient_targets_after_stale_exclusion' : 'magi_insufficient_targets',
            error: droppedByStale
                ? `Panel '${panelName}' resolves to only ${plan.distinctTargets} independent (node, provider) target(s) AFTER excluding ${plan.staleMembers.length} git-stale member(s) (HEAD differs from reference ${referenceCommit ?? '(unknown)'}); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`
                : `Panel '${panelName}' resolves to ${plan.distinctTargets} available (node, provider) target(s); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`,
            ...(referenceCommit ? { referenceCommit } : {}),
            unavailableMembers: plan.unavailableMembers,
            ...(droppedByStale ? { staleMembers: plan.staleMembers } : {}),
            hint: droppedByStale
                ? 'Bring the stale node(s) to the reference commit, or pass include_stale=true to mesh_magi_review to fan out to them anyway (results will be git-skewed). Use mesh_magi_panel_list to inspect resolution.'
                : 'Use mesh_magi_panel_list to see resolution, mesh_magi_panel_set to fix members, mesh_status to confirm nodes/providers are online.',
        }, null, 2);
    }

    const mode = readString(args.mode) as MagiMode | '';
    const requireIndependentEvidence = (args.require_independent_evidence ?? args.requireIndependentEvidence) !== false;
    const wait = args.wait !== false;
    const waitTimeoutMs = Math.min(MAGI_MAX_WAIT_MS, Math.max(MAGI_POLL_INTERVAL_MS, Number(args.wait_timeout_ms ?? args.waitTimeoutMs) || MAGI_DEFAULT_WAIT_MS));

    // 3. Mission container + shared consensus group id.
    const consensusGroupId = `magi_${randomUUID().replace(/-/g, '')}`;
    const titleQ = question.length > 80 ? `${question.slice(0, 77)}...` : question;
    const mission = upsertMeshMission(ctx.mesh.id, {
        title: `MAGI: ${titleQ}`,
        goal: `Cross-verify (read-only) across panel '${panelName}': ${question}${args.target ? `\nTarget: ${args.target}` : ''}`,
    });

    // 4. Enqueue one read-only task per replica, all sharing the consensus group id.
    const prompt = buildMagiTaskPrompt({ question, target: args.target, artifacts: args.artifacts, mode: (mode || undefined) as MagiMode | undefined, taskKind });
    const replicaRecords: Array<{ taskId: string; provider: string; targetNodeId?: string; requiredTags: string[] }> = [];
    for (const replica of plan.replicas) {
        try {
            const task = enqueueTask(ctx.mesh.id, prompt, {
                readonly: true,
                taskMode: 'live_debug_readonly',
                requiredTags: replica.requiredTags,
                missionId: mission.id,
                consensusGroupId,
                ...(replica.targetNodeId ? { targetNodeId: replica.targetNodeId } : {}),
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
        ...(hasInlineMembers ? { inline: true } : {}),
        taskKind,
        ...(questionSchemaWarning ? { questionSchemaWarning } : {}),
        ...(judgeWarning ? { judgeWarning } : {}),
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
        // Surface git-stale handling: which members were excluded (default), or included
        // despite being stale (include_stale=true) — the latter makes results git-skewed.
        ...(plan.staleMembers.length > 0 ? {
            gitStaleExcluded: plan.staleMembers,
            gitStaleWarning: `${plan.staleMembers.length} git-stale member(s) (HEAD ≠ reference ${plan.referenceCommit ?? '(unknown)'}) were excluded from this fan-out; pass include_stale=true to include them.`,
        } : {}),
        ...(plan.includedStaleMembers.length > 0 ? {
            gitStaleIncluded: plan.includedStaleMembers,
            gitStaleWarning: `include_stale=true: ${plan.includedStaleMembers.length} git-stale member(s) (HEAD ≠ reference ${plan.referenceCommit ?? '(unknown)'}) were INCLUDED — their evidence compares different code, so synthesis will be git-skewed.`,
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
        synthesis,
    });
    // FIX#3: this inline review owns `mission` — auto-close it once all replicas are terminal.
    closeMagiMissionIfTerminal(ctx, mission.id, collected.terminal);

    return JSON.stringify({
        ...baseResult,
        waited: true,
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
        synthesis,
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
        ? Math.min(MAGI_MAX_WAIT_MS, Math.max(MAGI_POLL_INTERVAL_MS, Number(args.wait_timeout_ms ?? args.waitTimeoutMs) || MAGI_DEFAULT_WAIT_MS))
        : 0;

    const replicaTaskIds = replicaTasks.map((t: any) => readString(t.id)).filter(Boolean) as string[];
    const collected = await collectMagiResponses(ctx, { replicaTaskIds, timeoutMs, taskKind });
    const synthesis = synthesizeMagiResponses(collected.responses, {
        replicasExpected: replicaTaskIds.length,
        requireIndependentEvidence,
    });
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
        synthesis,
    });
    // FIX#3: the inline mission id comes from the replica tasks' OWN missionId (MAGI-owned,
    // guard a) — auto-close it once all replicas are terminal.
    closeMagiMissionIfTerminal(ctx, replicaMissionId, collected.terminal);

    return JSON.stringify({
        success: true,
        consensusGroupId,
        taskKind,
        replicaCount: replicaTaskIds.length,
        waited: wait,
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
        synthesis,
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
 * Persist the synthesis as a `magi_synthesis` ledger entry, retrievable by
 * consensusGroupId (getMeshMagiActivityByGroup) and foldable into mesh_status. The full
 * synthesis is stored; mesh_status bounds it on read. Best-effort.
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
            // Still running and not stale → only finalize at the deadline.
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
            const payload = unwrapCommandPayload(result);
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
        // the deadline, then finalize as unparseable (preferring any provisional answer).
        if (force) {
            const prov = provisional.get(taskId);
            if (prov) {
                finalized.set(taskId, prov);
                return true;
            }
            source.error = isSchemaFailure ? `schema_invalid: ${kindResult.failReason}` : 'unparseable_output';
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
