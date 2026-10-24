import type { OwnedPathEntry } from './path-ownership'

export type MeshTaskPhase = 'source' | 'integration'

/** Host-produced evidence. Never accepted from MCP/peer-supplied paths or branch labels. */
export interface PhysicalOwnershipScope {
    version: 1
    repoIdentity: string
    machineId: string
    nodeId: string
    worktree: string
    worktreeIdentity: string
    gitDir: string
    commonGitDir: string
    phase: MeshTaskPhase
    gitResources: { index: string; refs: string; hooks: string; config: string }
    resources: Array<{ path: string; identity?: string; subtree: boolean }>
    declaration: readonly OwnedPathEntry[]
}

/** A source packet is an input to integration, never release/feature acceptance. */
export interface MeshSourceCandidate {
    version: 1
    readiness: 'uncommitted' | 'verified_source_candidate'
    taskId: string
    missionId: string
    revision: number
    repoIdentity: string
    machineId: string
    canonicalWorktree: string
    rootBaseSha: string
    ossBaseSha: string
    rootCandidateSha?: string
    ossCandidateSha?: string
    patchSha256: string
    manifestSha256: string
    touchedPaths: string[]
    tests: Array<{ command: string; exit: number; logSha256: string }>
    settledCommands: boolean
    integrationTaskId: string
    logicalOverlapTaskIds: string[]
}

/** Product B consumes one frozen batch; normal hooks/parity/gates remain required. */
export interface MeshIntegrationBatchContract {
    version: 1
    batchId: string
    candidates: MeshSourceCandidate[]
    integrationOrder: string[]
    approvedRootSha: string
    approvedOssSha: string
    bundleInvocationCount: 1
    requiredGates: string[]
    normalHooksRequired: true
    independentReviewRequired: true
    ownerLandingApprovalRequired: true
}

/** These only rank legal targets; targetNodeId/SessionId and requiredTags remain hard. */
export interface MeshRoutingPreferences { nodeIds?: string[]; providers?: string[] }
export interface MeshReviewConstraint { sourceTaskId: string; differentProvider: true }
