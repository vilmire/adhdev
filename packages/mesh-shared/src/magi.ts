/**
 * MAGI — Multi-Agent Ground-truth Insight.
 *
 * Pure shared types for the mesh cross-verification quorum: panel definitions
 * (machine-local config, stored in ~/.adhdev/meshes.json `magiPanels`), the
 * agent-agnostic common output schema every dispatched replica answers with,
 * and the synthesis result shapes. These cross the daemon-core (storage /
 * accessors) ↔ mcp-server (fan-out / synthesis) boundary, so they live in the
 * dependency-free mesh-shared leaf — no runtime, no Node/DOM APIs.
 *
 * Design: docs/design/2026-06-28-mesh-magi-review.md. Core stance: no personas,
 * no named lenses — a panel member is just one `(node × provider)` target that
 * answers the SAME question. The value is the friction (contested / singleton /
 * source-coupled findings), NOT a majority vote.
 */

// ─── Panel model (machine-local config) ─────────

/**
 * One panel member: a `(node × provider)` target that answers the shared
 * question. `provider` is required; `nodeId` pins a concrete mesh node (forbidden
 * in the repo-portable abstract form), `capabilityTags` route by tag when no
 * nodeId is given. `n` is an optional per-member replica count.
 */
export interface MagiPanelMember {
    /** Optional — pin to a specific mesh node id. Absent → route by capabilityTags + provider. */
    nodeId?: string
    /** Optional routing tags (e.g. 'os=darwin'), ANDed with the provider tag when nodeId is absent. */
    capabilityTags?: string[]
    /** REQUIRED — provider type, e.g. 'claude-cli' | 'codex-cli' | 'hermes-cli' | 'gemini-cli'. */
    provider: string
    /** Optional per-member replica count; defaults to the panel.defaultN / global n / 1. */
    n?: number
}

/**
 * A named MAGI panel. Stored machine-local in `~/.adhdev/meshes.json` under the
 * top-level `magiPanels` map (sibling to `meshes`), because a member binds
 * concrete node identity + provider availability — both machine-dependent facts.
 */
export interface MagiPanel {
    /** Optional human label, e.g. 'design-review'. */
    description?: string
    members: MagiPanelMember[]
    /** Replicas per member when member.n is absent; default 1. */
    defaultN?: number
    /** Marks the panel's fan-out as intentional same-prompt duplication (always true in practice). */
    dedupExempt?: boolean
}

/** Top-level `magiPanels` map in meshes.json, keyed by panel name. */
export type MagiPanelMap = Record<string, MagiPanel>

/**
 * Synthesis emphasis hint. Affects weighting / labels only — NEVER the agent
 * count or the common schema. (Per-mode weighting tuning is a deferred refinement;
 * the field is accepted now so callers and panels are forward-stable.)
 */
export type MagiMode = 'rca' | 'investigation' | 'claim_audit' | 'design_review' | 'code_audit'

// ─── Common output schema (agent-agnostic) ──────

export type MagiClaimStance = 'support' | 'oppose' | 'uncertain'

/**
 * One claim from one agent. `evidence` carries `file:line` or external-source
 * strings; `confidence` is 0..1. Identical regardless of which provider/machine
 * produced it — this is the forced structured-output contract injected into each
 * dispatched task prompt.
 */
export interface MagiClaim {
    claim: string
    stance: MagiClaimStance
    evidence: string[]
    confidence: number
}

/** The agent-agnostic response every dispatched replica returns. */
export interface MagiAgentResponse {
    claims: MagiClaim[]
    top_findings: string[]
    open_questions: string[]
}

// ─── Synthesis result shapes ────────────────────

/**
 * Where one response came from — the `(node × provider)` identity that backs a
 * claim's independence. `ok=false` marks a replica that died / produced no
 * parseable common-schema output (excluded from clusters, counted as missing).
 */
export interface MagiResponseSource {
    /** Mesh task id of the dispatched replica. */
    taskId: string
    nodeId?: string
    provider?: string
    /** False when the replica failed or its output could not be parsed. */
    ok: boolean
    /** Reason when ok=false (timeout / failed / unparseable / stale). */
    error?: string
    /**
     * True when the replica was detected STALE during collection — assigned to a
     * node/session no longer present in the live mesh (so it will never reach a
     * terminal state). Distinguishes a dead-assignment replica from one that is
     * merely still generating. Always implies ok=false.
     */
    stale?: boolean
    /**
     * Git ref of the node this replica ran on, captured at collection time from the
     * live mesh node's compact git summary. Lets synthesis (and a dashboard) detect
     * GIT SKEW across the panel — if the answering replicas span different branches
     * or diverge (ahead/behind), their file:line evidence is comparing different code
     * and "agreement" is less meaningful. Best-effort; absent when the node carried
     * no git summary.
     */
    git?: MagiReplicaGitRef
}

/** Compact git ref of the node a replica ran on (subset of GitRepoStatus). */
export interface MagiReplicaGitRef {
    branch?: string | null
    /** HEAD commit sha of the node's workspace — the exact code the replica saw. */
    headCommit?: string | null
    ahead?: number
    behind?: number
    dirty?: boolean
}

/**
 * Cross-replica git divergence assessment. `skewed` is true when the answering
 * replicas span more than one branch OR any replica diverges from its upstream
 * (ahead/behind > 0) — both mean the panel is not all looking at the same code, so
 * file:line evidence and agreement are git-skewed. Always present on a synthesis
 * (skewed=false / distinctBranches≤1 when there is nothing to flag).
 */
export interface MagiGitSkew {
    skewed: boolean
    /** Number of distinct branches across the answering replicas with a known branch. */
    distinctBranches: number
    /** The distinct branch names (sorted), for display. */
    branches: string[]
    /** Replicas whose branch/divergence differs from the panel baseline. */
    divergentReplicas: number
    note?: string
}

/** A parsed replica response paired with its source identity. */
export interface MagiSynthesizedResponse {
    source: MagiResponseSource
    response: MagiAgentResponse
}

/**
 * Synthesis category for a claim cluster. `needs_verification` is the PRIMARY
 * OUTPUT = contested ∪ singleton ∪ source_coupled ∪ (high-impact claims lacking
 * independent evidence). `agreed` is the only "safe to trust, low priority" bucket.
 */
export type MagiClusterCategory =
    | 'agreed'
    | 'contested'
    | 'dissent'
    | 'singleton'
    | 'source_coupled'

/** One member observation inside a claim cluster. */
export interface MagiClusterMember {
    taskId: string
    nodeId?: string
    provider?: string
    claim: string
    stance: MagiClaimStance
    evidence: string[]
    confidence: number
}

/**
 * A cluster of semantically-equivalent claims across responses, with its
 * stance tally and diversity-weighted independence assessment.
 */
export interface MagiClaimCluster {
    /** Representative (first / longest) claim text for the cluster. */
    claim: string
    category: MagiClusterCategory
    members: MagiClusterMember[]
    stance: { support: number; oppose: number; uncertain: number }
    /** Distinct providers / nodes / evidence sources backing the cluster. */
    distinctProviders: number
    distinctNodes: number
    distinctEvidence: number
    /** Diversity-weighted independence score (NOT the raw agent count). */
    independenceScore: number
    /** True when this cluster is routed to needs_verification. */
    needsVerification: boolean
    /** Why it needs verification (contested / singleton / source_coupled / no_independent_evidence). */
    reasons: string[]
}

/** The full synthesis result — N-agnostic, diversity-weighted, not a vote. */
export interface MagiSynthesis {
    /** How many replicas were expected vs. produced parseable output. */
    replicasExpected: number
    replicasAnswered: number
    replicasMissing: number
    /** Distinct providers / nodes across the answering replicas. */
    distinctProviders: number
    distinctNodes: number
    /**
     * Set when the resolved panel collapsed to a single provider or single
     * machine — agreements are then flagged source-coupled. Null when independence
     * was achieved.
     */
    independenceBanner: string | null
    clusters: MagiClaimCluster[]
    /** PRIMARY OUTPUT — clusters routed to needs_verification, highest priority first. */
    needsVerification: MagiClaimCluster[]
    /** High-independence agreements — safe to trust, lowest review priority. */
    agreed: MagiClaimCluster[]
    /** Union of every response's open_questions (deduped). */
    openQuestions: string[]
    /**
     * Per-replica source identity (taskId / nodeId / provider / ok / stale / git) for
     * every replica in the fan-out. Lets a consumer (the dashboard's extractMagiActivity)
     * read which node × provider answered and the git ref each ran at — the inputs behind
     * the gitSkew assessment.
     */
    replicas: MagiResponseSource[]
    /**
     * Cross-replica git divergence. When skewed, the answering replicas were not all
     * on the same code (different branches / ahead-behind), so evidence and agreement
     * should be read with that caveat. Always present.
     */
    gitSkew: MagiGitSkew
}
