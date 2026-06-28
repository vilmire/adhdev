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
    annotateQueueStaleness,
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
    normalizeMagiPanel,
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
        members?: unknown;
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

    // deltaE: persist the fan-out so the group is visible in mesh_status (running) and
    // survives a coordinator restart even before any synthesis is collected.
    persistMagiDispatched(ctx, {
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        replicaCount: replicaRecords.length,
    });

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
        ...(hasInlineMembers ? { inline: true } : {}),
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
            pollWith: { tool: 'mesh_magi_collect', args: { consensus_group_id: consensusGroupId } },
            nextAction: `Replicas are running. Drive off mission completion / pendingCoordinatorEvents rather than polling chat, then collect + synthesize once with mesh_magi_collect({ consensus_group_id: '${consensusGroupId}' }).`,
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

    // deltaE: persist the synthesis (retrievable by consensusGroupId; folds into mesh_status).
    persistMagiSynthesis(ctx, {
        consensusGroupId,
        missionId: mission.id,
        panel: panelName,
        question,
        staleReplicas: collected.staleCount,
        synthesis,
    });

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
            ...(synthesis.replicasMissing > 0 ? { missingNote: `Partial synthesis — ${synthesis.replicasMissing} of ${replicaRecords.length} replicas did not return a parseable response (timed out / failed / unparseable / stale).` } : {}),
        },
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
    },
): Promise<string> {
    const consensusGroupId = readString(args.consensus_group_id) || readString(args.consensusGroupId);
    if (!consensusGroupId) return JSON.stringify({ success: false, error: 'consensus_group_id required' });

    await refreshMeshFromDaemon(ctx);

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
    const collected = await collectMagiResponses(ctx, { replicaTaskIds, timeoutMs });
    const synthesis = synthesizeMagiResponses(collected.responses, {
        replicasExpected: replicaTaskIds.length,
        requireIndependentEvidence,
    });

    // deltaE: persist the synthesis (panel/question are merged from the earlier
    // magi_dispatched entry by consensusGroupId, so they need not be re-derived here).
    persistMagiSynthesis(ctx, {
        consensusGroupId,
        missionId: readString(replicaTasks[0]?.missionId),
        staleReplicas: collected.staleCount,
        synthesis,
    });

    return JSON.stringify({
        success: true,
        consensusGroupId,
        replicaCount: replicaTaskIds.length,
        waited: wait,
        collection: {
            terminal: collected.terminal,
            timedOut: collected.timedOut,
            answered: synthesis.replicasAnswered,
            missing: synthesis.replicasMissing,
            staleReplicas: collected.staleCount,
            ...(collected.staleCount > 0 ? { staleNote: `${collected.staleCount} replica(s) were detected STALE — assigned to a node/session no longer present in the live mesh.` } : {}),
            ...(!collected.terminal ? { pendingNote: 'Not all replicas are terminal yet — this is a partial snapshot. Re-collect once mission/pendingCoordinatorEvents report more completions.' } : {}),
        },
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
    args: { consensusGroupId: string; missionId?: string; panel?: string; question?: string; replicaCount: number },
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
            },
        });
    } catch { /* ledger write is best-effort */ }
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
 * Pull a compact git ref off a live mesh node (its GitCompactSummary, populated by the
 * daemon git monitor) for deltaA git-skew. Returns undefined when the node carries no
 * git summary — refs are best-effort, never fabricated.
 */
function extractNodeGitRef(node: any): MagiReplicaGitRef | undefined {
    const git = node?.git;
    if (!git || typeof git !== 'object') return undefined;
    const ref: MagiReplicaGitRef = {};
    if (typeof git.branch === 'string' || git.branch === null) ref.branch = git.branch;
    if (typeof git.ahead === 'number' && Number.isFinite(git.ahead)) ref.ahead = git.ahead;
    if (typeof git.behind === 'number' && Number.isFinite(git.behind)) ref.behind = git.behind;
    if (typeof git.dirty === 'boolean') ref.dirty = git.dirty;
    return Object.keys(ref).length > 0 ? ref : undefined;
}

async function collectMagiResponses(
    ctx: MeshContext,
    args: { replicaTaskIds: string[]; timeoutMs: number },
): Promise<{ responses: MagiSynthesizedResponse[]; terminal: boolean; timedOut: boolean; staleCount: number }> {
    const ids = new Set(args.replicaTaskIds);
    const deadline = Date.now() + args.timeoutMs;
    const TERMINAL = MAGI_TERMINAL_STATUSES;
    let terminal = false;
    // Poll the queue until every replica is terminal, every remaining replica is
    // detected STALE (a dead assignment that will never complete — featureA), or the
    // deadline elapses. Stale detection lets us stop early instead of blocking the
    // full timeout on a replica whose node/session has gone away.
    for (;;) {
        const tasks = annotateQueueStaleness(getQueue(ctx.mesh.id).filter((t: any) => ids.has(t.id)), ctx.mesh);
        const allPresent = tasks.length === ids.size;
        if (allPresent && tasks.every((t: any) => TERMINAL.has(String(t.status)))) { terminal = true; break; }
        const nonTerminal = tasks.filter((t: any) => !TERMINAL.has(String(t.status)));
        const { staleTaskIds } = classifyStaleReplicas(tasks, TERMINAL);
        if (allPresent && nonTerminal.length > 0 && staleTaskIds.size === nonTerminal.length) {
            // Every replica still outstanding is stuck on a dead assignment — no point
            // waiting out the clock. Stop now; the per-task pass below records them stale.
            break;
        }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(MAGI_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    const tasks = annotateQueueStaleness(getQueue(ctx.mesh.id).filter((t: any) => ids.has(t.id)), ctx.mesh);
    const { staleTaskIds, staleReasons } = classifyStaleReplicas(tasks, TERMINAL);
    const responses: MagiSynthesizedResponse[] = [];
    for (const task of tasks as any[]) {
        const sourceNodeId = task.assignedNodeId || task.targetNodeId || undefined;
        // deltaA: capture the replica node's git ref so synthesis can flag cross-replica
        // git skew. Best-effort, from the live node's compact git summary — no extra git
        // command in the collection hot path.
        const gitRef = extractNodeGitRef(sourceNodeId ? ctx.mesh.nodes.find(n => meshNodeIdMatches(n as any, sourceNodeId)) : undefined);
        const source: MagiResponseSource = {
            taskId: task.id,
            nodeId: sourceNodeId,
            provider: task.assignedProviderType || undefined,
            ok: false,
            ...(gitRef ? { git: gitRef } : {}),
        };
        if (task.status !== 'completed' || !task.assignedNodeId || !task.assignedSessionId) {
            if (staleTaskIds.has(task.id)) {
                source.stale = true;
                source.error = `stale: ${staleReasons[task.id]}`;
            } else {
                source.error = task.status === 'completed' ? 'no_session_to_read' : `replica_${task.status || 'incomplete'}`;
            }
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
    return { responses, terminal, timedOut: !terminal, staleCount: staleTaskIds.size };
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
