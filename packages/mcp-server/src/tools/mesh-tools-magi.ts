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
    IpcTransport,
    appendLedgerEntry,
    buildMeshNodeCapabilityTags,
    commandForNode,
    enqueueTask,
    getMagiPanel,
    getQueue,
    isLocalControlPlaneNode,
    ipcDispatchToRemoteAgent,
    listMagiPanels,
    meshNodeIdMatches,
    nodeSatisfiesRequiredTags,
    normalizeMeshCapabilityTags,
    randomUUID,
    readString,
    refreshMeshFromDaemon,
    resolveCoordinatorDaemonId,
    summarizeTaskMessage,
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
    MagiMode,
    MagiPanel,
    MagiPanelMember,
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
/** Lexical-cluster merge threshold (Jaccard over claim token sets). */
const MAGI_CLUSTER_JACCARD = 0.5;
/** Default wall-clock budget for wait=true replica collection. */
const MAGI_DEFAULT_WAIT_MS = 180_000;
const MAGI_MAX_WAIT_MS = 600_000;
const MAGI_POLL_INTERVAL_MS = 5_000;

// ─── Common output schema parsing (pure) ────────

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

/** Looks like specific source evidence (file:line / path), a strong merge signal. */
function isSpecificEvidence(ev: string): boolean {
    return /[\w/.\\-]+:\d+/.test(ev) || /[\w-]+\.[a-z]{1,5}\b/i.test(ev);
}

function normalizeEvidence(ev: string): string {
    return ev.toLowerCase().replace(/\s+/g, ' ').trim();
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
}

function replicaCountFor(member: MagiPanelMember, panel: MagiPanel, globalN?: number): number {
    const n = member.n ?? panel.defaultN ?? globalN ?? 1;
    return Math.max(1, Math.floor(n));
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
    opts: { n?: number; maxReplicas?: number } = {},
): MagiFanoutPlan {
    const cap = Math.max(1, Math.floor(opts.maxReplicas ?? MAGI_MAX_REPLICAS));
    const members = Array.isArray(panel.members) ? panel.members : [];
    const replicas: MagiReplicaPlan[] = [];
    const unavailableMembers: MagiUnavailableMember[] = [];
    const targetKeys = new Set<string>();
    const providerSet = new Set<string>();
    const nodeTargetSet = new Set<string>();
    let totalRequested = 0;

    members.forEach((member, memberIndex) => {
        const provider = member.provider;
        const capabilityTags = normalizeMeshCapabilityTags(member.capabilityTags);
        const requiredTags = normalizeMeshCapabilityTags([`provider=${provider}`, ...capabilityTags]);
        const count = replicaCountFor(member, panel, opts.n);

        // Resolve availability against the mesh.
        let targetNodeId: string | undefined;
        let available = false;
        if (member.nodeId) {
            const node = nodes.find(n => meshNodeIdMatches(n as any, member.nodeId!));
            if (node) { targetNodeId = (node as any).id; available = true; }
        } else {
            // Match against each node's OWN advertised tags (provider derived from its
            // policy.providerPriority), NOT a provider we inject — passing `provider`
            // here would synthesize a provider= tag and make the filter always pass.
            // Mirrors the queue's availability check (mesh-tools-queue.ts).
            available = nodes.some(n => nodeSatisfiesRequiredTags(requiredTags, buildMeshNodeCapabilityTags(n)));
        }

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
            return;
        }

        totalRequested += count;
        const targetKey = targetNodeId ? `node:${targetNodeId}` : `tags:${[...requiredTags].sort().join(',')}`;
        targetKeys.add(`${targetKey}|${provider}`);
        providerSet.add(provider);
        nodeTargetSet.add(targetKey);
        for (let i = 0; i < count; i++) {
            replicas.push({ memberIndex, provider, targetNodeId, capabilityTags, requiredTags });
        }
    });

    // Clamp to the guard cap (drop the tail; the caller logs the drop).
    const droppedReplicas = Math.max(0, replicas.length - cap);
    const capped = droppedReplicas > 0 ? replicas.slice(0, cap) : replicas;

    const distinctProviders = providerSet.size;
    const distinctNodeTargets = nodeTargetSet.size;
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
    };
}

// ─── Task prompt (common-schema contract) ───────

const MAGI_OUTPUT_CONTRACT = `When done, respond with ONLY a single JSON object (no prose, no code fence) matching this exact schema:
{
  "claims": [ { "claim": "string", "stance": "support | oppose | uncertain", "evidence": ["file:line or external source"], "confidence": 0.0 } ],
  "top_findings": ["string"],
  "open_questions": ["string"]
}
Each claim MUST carry concrete evidence (file:line or a cited source) where possible — unevidenced high-confidence claims are flagged for re-verification. "stance" is your stance toward the claim being true. Do not invent agreement; report uncertainty honestly.`;

export function buildMagiTaskPrompt(args: {
    question: string;
    target?: string;
    artifacts?: string[];
    mode?: MagiMode;
}): string {
    const parts: string[] = [];
    parts.push('You are one independent member of a multi-agent cross-verification quorum (MAGI). Several other agents on different machines/providers are answering the SAME question independently; your job is a rigorous, READ-ONLY investigation. Do NOT write, edit, commit, or push anything.');
    if (args.mode) parts.push(`Investigation mode: ${args.mode}.`);
    parts.push(`\n## Question\n${args.question.trim()}`);
    if (args.target && args.target.trim()) parts.push(`\n## Target to investigate\n${args.target.trim()}`);
    if (Array.isArray(args.artifacts) && args.artifacts.length > 0) {
        parts.push(`\n## Artifacts\n${args.artifacts.map(a => String(a)).join('\n\n---\n\n')}`);
    }
    parts.push(`\n## Output\n${MAGI_OUTPUT_CONTRACT}`);
    return parts.join('\n');
}

// ─── Worker-output extraction (best-effort) ─────

function extractAssistantText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    const p = payload as Record<string, any>;
    const messages = Array.isArray(p.messages) ? p.messages
        : Array.isArray(p.chat) ? p.chat
        : Array.isArray(p.transcript) ? p.transcript
        : [];
    const texts: string[] = [];
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const role = String((msg as any).role || (msg as any).from || '').toLowerCase();
        if (role && role !== 'assistant' && role !== 'agent' && role !== 'model') continue;
        const content = (msg as any).content ?? (msg as any).text ?? (msg as any).message;
        if (typeof content === 'string') texts.push(content);
        else if (Array.isArray(content)) {
            for (const part of content) {
                if (typeof part === 'string') texts.push(part);
                else if (part && typeof part === 'object' && typeof (part as any).text === 'string') texts.push((part as any).text);
            }
        }
    }
    if (texts.length > 0) return texts[texts.length - 1];
    // Fallbacks for flatter payload shapes.
    return readString(p.finalSummary) || readString(p.lastMessagePreview) || readString(p.text) || '';
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

/** Validate + normalize a panel config for dry-run preview (mirrors the accessor's normalizer). */
function previewMagiPanel(config: unknown): MagiPanel {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('invalid_magi_panel: config must be an object');
    }
    const raw = config as Record<string, unknown>;
    const rawMembers = raw.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
        throw new Error('invalid_magi_panel: members must be a non-empty array');
    }
    const members: MagiPanelMember[] = rawMembers.map((entry, idx) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`invalid_magi_panel: member[${idx}] must be an object`);
        }
        const m = entry as Record<string, unknown>;
        const provider = typeof m.provider === 'string' ? m.provider.trim() : '';
        if (!provider) throw new Error(`invalid_magi_panel: member[${idx}].provider is required`);
        const nodeId = typeof m.nodeId === 'string' && m.nodeId.trim() ? m.nodeId.trim() : undefined;
        const capabilityTags = normalizeMeshCapabilityTags(m.capabilityTags);
        const n = typeof m.n === 'number' && Number.isFinite(m.n) && m.n >= 1 ? Math.floor(m.n) : undefined;
        return {
            provider,
            ...(nodeId ? { nodeId } : {}),
            ...(capabilityTags.length ? { capabilityTags } : {}),
            ...(n !== undefined ? { n } : {}),
        };
    });
    const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 200) : undefined;
    const defaultN = typeof raw.defaultN === 'number' && Number.isFinite(raw.defaultN) && raw.defaultN >= 1 ? Math.floor(raw.defaultN) : undefined;
    return {
        ...(description ? { description } : {}),
        members,
        ...(defaultN !== undefined ? { defaultN } : {}),
        dedupExempt: raw.dedupExempt === false ? false : true,
    };
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
    const panels = names.map(name => {
        const panel = all[name];
        const plan = buildMagiFanoutPlan(panel, ctx.mesh.nodes, {});
        return {
            name,
            description: panel.description,
            members: panel.members,
            defaultN: panel.defaultN ?? 1,
            resolution: {
                totalReplicas: plan.totalAfterCap,
                distinctTargets: plan.distinctTargets,
                distinctProviders: plan.distinctProviders,
                distinctMachines: plan.distinctNodeTargets,
                enoughTargets: plan.enoughTargets,
                coupled: plan.coupled,
                unavailableMembers: plan.unavailableMembers,
            },
            ...(plan.coupled ? { warning: 'This panel collapses to a single provider or single machine — its agreements would be flagged source-coupled.' } : {}),
            ...(!plan.enoughTargets ? { error: `Resolves to ${plan.distinctTargets} distinct (node, provider) target(s); MAGI requires ≥${MAGI_MIN_TARGETS}.` } : {}),
        };
    });
    return JSON.stringify({ success: true, count: panels.length, panels }, null, 2);
}

export async function meshMagiReview(
    ctx: MeshContext,
    args: {
        question?: string;
        target?: string;
        artifacts?: string[];
        panel?: string;
        n?: number;
        mode?: string;
        require_independent_evidence?: boolean;
        requireIndependentEvidence?: boolean;
        wait?: boolean;
        wait_timeout_ms?: number;
        waitTimeoutMs?: number;
    },
): Promise<string> {
    const question = readString(args.question);
    if (!question) return JSON.stringify({ success: false, error: 'question required' });

    await refreshMeshFromDaemon(ctx);

    // 1. Resolve panel (named, else "default").
    const panelName = readString(args.panel) || 'default';
    const panel = getMagiPanel(panelName);
    if (!panel) {
        return JSON.stringify({
            success: false,
            code: 'magi_panel_missing',
            error: `MAGI panel '${panelName}' is not configured. Define it first with mesh_magi_panel_set, and inspect resolution with mesh_magi_panel_list.`,
            configuredPanels: Object.keys(listMagiPanels()),
        });
    }

    // 2. Plan the fan-out and enforce the ≥2-target guard.
    const plan = buildMagiFanoutPlan(panel, ctx.mesh.nodes, { n: args.n });
    if (!plan.enoughTargets) {
        return JSON.stringify({
            success: false,
            code: 'magi_insufficient_targets',
            error: `Panel '${panelName}' resolves to ${plan.distinctTargets} available (node, provider) target(s); MAGI requires ≥${MAGI_MIN_TARGETS} and never silently degrades to N=1.`,
            unavailableMembers: plan.unavailableMembers,
            hint: 'Use mesh_magi_panel_list to see resolution, mesh_magi_panel_set to fix members, mesh_status to confirm nodes/providers are online.',
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
    const prompt = buildMagiTaskPrompt({ question, target: args.target, artifacts: args.artifacts, mode: (mode || undefined) as MagiMode | undefined });
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

    // 5. Trigger local queue pickup; eager P2P push for remote (IPC) targets.
    const queueTrigger = await triggerMeshQueueAndReport(ctx);
    if (ctx.transport instanceof IpcTransport) {
        await eagerlyDispatchRemoteReplicas(ctx, replicaRecords, prompt, mission.id, consensusGroupId);
    }

    const baseResult = {
        success: true,
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        replicaCount: replicaRecords.length,
        replicas: replicaRecords.map(r => ({ taskId: r.taskId, provider: r.provider, targetNodeId: r.targetNodeId })),
        independence: {
            distinctProviders: plan.distinctProviders,
            distinctMachines: plan.distinctNodeTargets,
            coupled: plan.coupled,
            ...(plan.coupled ? { banner: 'Panel collapsed to a single provider or machine — agreements will be flagged source-coupled.' } : {}),
        },
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
            nextAction: 'Replicas are running. Synthesis runs when you re-collect; drive off mission completion / pendingCoordinatorEvents rather than polling chat.',
        }, null, 2);
    }

    // 6. Collect by consensus group id (bounded), then synthesize.
    const collected = await collectMagiResponses(ctx, {
        replicaTaskIds: replicaRecords.map(r => r.taskId),
        timeoutMs: waitTimeoutMs,
    });
    const synthesis = synthesizeMagiResponses(collected.responses, {
        replicasExpected: replicaRecords.length,
        requireIndependentEvidence,
    });

    return JSON.stringify({
        ...baseResult,
        waited: true,
        collection: {
            terminal: collected.terminal,
            timedOut: collected.timedOut,
            answered: synthesis.replicasAnswered,
            missing: synthesis.replicasMissing,
            ...(synthesis.replicasMissing > 0 ? { missingNote: `Partial synthesis — ${synthesis.replicasMissing} of ${replicaRecords.length} replicas did not return a parseable response (timed out / failed / unparseable).` } : {}),
        },
        synthesis,
    }, null, 2);
}

// ─── Collection (best-effort, bounded) ──────────

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function collectMagiResponses(
    ctx: MeshContext,
    args: { replicaTaskIds: string[]; timeoutMs: number },
): Promise<{ responses: MagiSynthesizedResponse[]; terminal: boolean; timedOut: boolean }> {
    const ids = new Set(args.replicaTaskIds);
    const deadline = Date.now() + args.timeoutMs;
    const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
    let terminal = false;
    // Poll the queue until every replica is terminal or the deadline elapses.
    for (;;) {
        const tasks = getQueue(ctx.mesh.id).filter((t: any) => ids.has(t.id));
        const allTerminal = tasks.length === ids.size && tasks.every((t: any) => TERMINAL.has(String(t.status)));
        if (allTerminal) { terminal = true; break; }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(MAGI_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    const tasks = getQueue(ctx.mesh.id).filter((t: any) => ids.has(t.id));
    const responses: MagiSynthesizedResponse[] = [];
    for (const task of tasks as any[]) {
        const source: MagiResponseSource = {
            taskId: task.id,
            nodeId: task.assignedNodeId || task.targetNodeId || undefined,
            provider: task.assignedProviderType || undefined,
            ok: false,
        };
        if (task.status !== 'completed' || !task.assignedNodeId || !task.assignedSessionId) {
            source.error = task.status === 'completed' ? 'no_session_to_read' : `replica_${task.status || 'incomplete'}`;
            responses.push({ source, response: { claims: [], top_findings: [], open_questions: [] } });
            continue;
        }
        try {
            const node = ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, task.assignedNodeId));
            if (!node) throw new Error('assigned node not in mesh');
            const result = await commandForNode(ctx, node, 'read_chat', {
                sessionId: task.assignedSessionId,
                targetSessionId: task.assignedSessionId,
                workspace: (node as any).workspace,
                tailLimit: 6,
            });
            const payload = unwrapCommandPayload(result);
            const text = extractAssistantText(payload);
            const parsed = parseMagiResponse(text);
            if (parsed) {
                responses.push({ source: { ...source, ok: true }, response: parsed });
            } else {
                source.error = 'unparseable_output';
                responses.push({ source, response: { claims: [], top_findings: [], open_questions: [] } });
            }
        } catch (e: any) {
            source.error = `read_failed: ${e?.message || String(e)}`;
            responses.push({ source, response: { claims: [], top_findings: [], open_questions: [] } });
        }
    }
    return { responses, terminal, timedOut: !terminal };
}

async function eagerlyDispatchRemoteReplicas(
    ctx: MeshContext,
    replicas: Array<{ taskId: string; provider: string; targetNodeId?: string; requiredTags: string[] }>,
    prompt: string,
    missionId: string,
    consensusGroupId: string,
): Promise<void> {
    const coordinatorDaemonId = resolveCoordinatorDaemonId(ctx);
    const dispatches: Promise<void>[] = [];
    for (const replica of replicas) {
        // Only eager-push to a concrete remote target. Tag-routed replicas with no
        // pinned node rely on the local queue trigger + reconcile (the coordinator
        // tunes the live cross-machine path); we never broadcast a task to many nodes.
        const node = replica.targetNodeId
            ? ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, replica.targetNodeId!))
            : undefined;
        if (!node || isLocalControlPlaneNode(ctx, node) || !(node as any).daemonId) continue;
        if (!nodeSatisfiesRequiredTags(replica.requiredTags, buildMeshNodeCapabilityTags(node))) continue;
        dispatches.push(
            ipcDispatchToRemoteAgent(ctx, node, {
                message: prompt,
                meshContext: {
                    meshId: ctx.mesh.id,
                    nodeId: (node as any).id,
                    taskId: replica.taskId,
                    ...(coordinatorDaemonId ? { coordinatorDaemonId } : {}),
                },
            })
                .then((result: any) => {
                    if (result?.success) {
                        try {
                            appendLedgerEntry(ctx.mesh.id, {
                                kind: 'task_dispatched',
                                nodeId: (node as any).id,
                                sessionId: result.sessionId,
                                providerType: result.providerType,
                                payload: {
                                    source: 'magi',
                                    via: 'p2p_direct',
                                    taskId: replica.taskId,
                                    missionId,
                                    consensusGroupId,
                                    ...summarizeTaskMessage(prompt),
                                    targetSessionId: result.sessionId,
                                },
                            });
                        } catch { /* best-effort */ }
                    }
                })
                .catch(() => { /* dispatch failure leaves the task pending for reconcile */ }),
        );
    }
    // Fire-and-forget — collection drives off task status, not this push.
    Promise.all(dispatches).catch(() => {});
}
