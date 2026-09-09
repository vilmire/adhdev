// Mesh tool implementations — MAGI pure core: task-kind normalization, response
// parsing/coercion (common schema + rca/design/freeform typed payloads), claim
// clustering, diversity-weighted synthesis, and git-skew computation.
//
// Extracted from mesh-tools-magi.ts (pure move, no behavior change) to keep that
// file under the repo file-size gate. Everything here is a pure function of its
// inputs — no MeshContext, queue, or transport dependency — which is exactly the
// "pure core" the header of mesh-tools-magi.ts describes; the handlers stay there
// and import this module. mesh-tools-magi.ts re-exports the public symbols so the
// mesh-tools.ts barrel and existing importers/tests are unaffected.

import { compactChatPayload } from './mesh-tools-internal.js';
import type {
    MagiAgentResponse,
    MagiClaim,
    MagiClaimCluster,
    MagiClusterMember,
    MagiGitSkew,
    MagiSynthesis,
    MagiSynthesizedResponse,
    MagiTaskKind,
} from './mesh-tools-internal.js';

/**
 * Lexical-cluster merge threshold (Jaccard over claim token sets).
 * FIX#2c: relaxed 0.5 → 0.4 so cross-provider same-conclusion claims worded a little
 * differently still merge (they were each becoming distinctProviders=1 singletons). Kept
 * conservative — the existing synthesis unit tests (singleton non-merge etc.) still pass at
 * 0.4 because their non-mergeable claims share zero content tokens (jaccard 0).
 */
const MAGI_CLUSTER_JACCARD = 0.4;

export const VALID_TASK_KINDS: readonly MagiTaskKind[] = ['claim_audit', 'rca', 'design', 'freeform'];
export const DEFAULT_TASK_KIND: MagiTaskKind = 'claim_audit';

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
