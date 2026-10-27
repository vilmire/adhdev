/**
 * Contract versioning (rc35 Cut A) — shared types, provisional budgets and the
 * content-free refusal vocabulary.
 *
 * Design SoT: the owner-approved rc25 contract-version design V2 (DESIGN.txt,
 * PROPOSED-DATA-CONTRACT.md, MVP-CUT.md) with owner decisions O1–O12 taken at
 * their recommended defaults (2026-10-21 "전부 권고대로") and the independent
 * review notes RN-01..RN-03 (owner packet §구현 순서).
 *
 * Three versions are deliberately distinct (PROPOSED-DATA-CONTRACT §1):
 *   - CONTRACT_PROTOCOL_VERSION — this tool/storage/eligibility protocol;
 *   - revisionId — the immutable digest of accepted normative content;
 *   - applicationApiVersion — a label INSIDE an API unit, bound to its digest.
 *
 * ★Budgets are PROPOSED, not measured (O9). They are configurable and every
 * excess is a bounded refusal — never truncation, never silent eviction.
 */

export const CONTRACT_PROTOCOL_VERSION = 1 as const;
/** Capability tag a node must expose to claim a strict-contract task (old-binary barrier). */
export const CONTRACT_STRICT_CAPABILITY_TAG = 'contract=strict-v1';
/** Bearer prefix of a daemon-minted coordinator contract capability. */
export const CONTRACT_CAPABILITY_PREFIX = 'csb_';

export interface ContractBudgets {
    /** Per normative unit, UTF-8/binary bytes. O9 proposal 32KiB. */
    maxUnitBytes: number;
    /** Per revision (sum of unit bytes). O9 proposal 256KiB. */
    maxRevisionBytes: number;
    /** Units per revision. O9 proposal 32. */
    maxUnitsPerRevision: number;
    /** Direct pins per task. O9 proposal 8. */
    maxDirectTaskPins: number;
    /** Compact dispatch pin block, UTF-8 bytes incl. delimiters. O9 proposal 1024. */
    maxPinBlockBytes: number;
    /** Aggregate private spool ceiling. Unmeasured provisional value. */
    maxSpoolBytes: number;
    /** One historical audit-quarantine body. Unmeasured provisional value. */
    maxQuarantineBodyBytes: number;
    /** Aggregate audit-quarantine ceiling. Unmeasured provisional value. */
    maxQuarantineBytes: number;
    /** Pending (undelivered) notices retained per dispatch binding before refusal/compaction. */
    maxPendingNoticesPerBinding: number;
    /** Bytes one contract_read may return. */
    maxReadBytesPerRequest: number;
    /** contract_read calls one binding may make (per-principal read quota). */
    maxReadsPerBinding: number;
    /** O8 proposal: closed unaccepted proposal bodies. */
    closedProposalRetentionMs: number;
    /** O8 proposal: ordinary tombstones (plus retry windows). */
    tombstoneRetentionMs: number;
    /** Coordinator capability lifetime. */
    capabilityTtlMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Owner-packet proposed values (O8/O9) — PROVISIONAL until measured and owner-confirmed. */
export const DEFAULT_CONTRACT_BUDGETS: Readonly<ContractBudgets> = Object.freeze({
    maxUnitBytes: 32 * 1024,
    maxRevisionBytes: 256 * 1024,
    maxUnitsPerRevision: 32,
    maxDirectTaskPins: 8,
    maxPinBlockBytes: 1024,
    maxSpoolBytes: 64 * 1024 * 1024,
    maxQuarantineBodyBytes: 64 * 1024,
    maxQuarantineBytes: 16 * 1024 * 1024,
    maxPendingNoticesPerBinding: 64,
    maxReadBytesPerRequest: 32 * 1024,
    maxReadsPerBinding: 512,
    closedProposalRetentionMs: 90 * DAY_MS,
    tombstoneRetentionMs: 30 * DAY_MS,
    capabilityTtlMs: DAY_MS,
});

/** Merge caller overrides onto the provisional defaults; non-positive / non-finite values are ignored. */
export function resolveContractBudgets(overrides?: Partial<Record<keyof ContractBudgets, unknown>> | null): ContractBudgets {
    const out: ContractBudgets = { ...DEFAULT_CONTRACT_BUDGETS };
    if (!overrides || typeof overrides !== 'object') return out;
    for (const key of Object.keys(DEFAULT_CONTRACT_BUDGETS) as Array<keyof ContractBudgets>) {
        const v = overrides[key];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = Math.floor(v);
    }
    return out;
}

/** Owner policy (O1–O12 recommended defaults). policyRevision is bumped on every change. */
export interface ContractPolicy {
    /** O2: coordinator delegation may accept nonbreaking changes. */
    delegateNonbreaking: boolean;
    /** O2: breaking changes require the owner directly (recommended false). */
    delegateBreaking: boolean;
    /** O3: qualified independent reviewers required for a normative change. */
    reviewerQuorum: number;
    /** O3: the author can never count as their own reviewer. */
    requireIndependentReviewer: boolean;
    /** O4: 'E2+C1' (recommended) or 'E2' (served-byte evidence only — never called a read acknowledgement). */
    evidenceMode: 'E2+C1' | 'E2';
    /** O6: narrowly scoped waivers allowed (exact result/purpose/vector/expiry). */
    allowWaivers: boolean;
    /** O6: longest waiver lifetime. */
    maxWaiverTtlMs: number;
    /** F1 rotation: bounded overlap of a rotated (not revoked) grant. 0 = none. */
    rotationOverlapMs: number;
    /** O5: late/offline material handling. */
    lateReportMode: 'prepared_provenance_quarantine' | 'refusal_local_only';
}

export const DEFAULT_CONTRACT_POLICY: Readonly<ContractPolicy> = Object.freeze({
    delegateNonbreaking: true,
    delegateBreaking: false,
    reviewerQuorum: 1,
    requireIndependentReviewer: true,
    evidenceMode: 'E2+C1',
    allowWaivers: true,
    maxWaiverTtlMs: 7 * DAY_MS,
    rotationOverlapMs: 0,
    lateReportMode: 'prepared_provenance_quarantine',
});

export type ContractImpact = 'nonbreaking' | 'breaking';

/** Operations a coordinator grant may carry. Enrollment/policy/transfer are owner-reserved and never grantable. */
export const CONTRACT_GRANT_OPS = ['propose', 'review', 'accept', 'assign', 'assess', 'revoke'] as const;
export type ContractGrantOp = typeof CONTRACT_GRANT_OPS[number];

/** The accepted head of a namespace. */
export interface ContractHeadVector {
    namespaceId: string;
    authorityEpoch: number;
    headGeneration: number;
    revisionId: string | null;
    policyRevision: number;
    revocationGeneration: number;
}

/** Expected-value precondition for CAS — a caller-supplied vector is never evidence of currency. */
export interface ContractExpectedHead {
    authorityEpoch: number;
    headGeneration: number;
    revisionId: string | null;
    policyRevision: number;
}

/** Qualified immutable source entry for one unit (O7: committed repository blob). */
export interface ContractSourceEntry {
    /** Enrolled repository binding id (never a caller-supplied filesystem path). */
    repoBindingId: string;
    hashAlgorithm: 'sha1' | 'sha256';
    /** Full commit OID in the repository named by repoBindingId (root of the chain). */
    commitOid: string;
    /** Gitlink chain root→child: each hop's path in its parent and the child commit it pins. */
    gitlinks: Array<{ path: string; childRepoBindingId: string; childCommitOid: string }>;
    /** Path of the blob inside the LAST repository of the chain. */
    path: string;
    blobOid: string;
    mode: string;
    byteLength: number;
    /** SHA-256 of the unfiltered blob bytes. */
    sha256: string;
}

export interface ContractUnitManifestEntry {
    unitId: string;
    digest: string;
    byteLength: number;
    mediaType: string;
    normativeType: 'contract' | 'api_schema' | 'guide';
    applicationApiVersion?: string;
    dependsOn: string[];
    roles: string[];
    sources: ContractSourceEntry[];
}

export interface ContractRevisionManifest {
    schema: 'adhdev.contract.revision/1';
    namespaceId: string;
    predecessorRevisionId: string | null;
    impact: ContractImpact;
    units: ContractUnitManifestEntry[];
}

/** Exact result reference (taskId alone and the latest mutable summary are insufficient). */
export interface ContractResultRef {
    meshId: string;
    taskId: string;
    attemptId: string;
    generation: number;
    outputVersion: number;
    payloadDigest: string;
}

export type ContractUsePurpose =
    | 'dependency'
    | 'handoff'
    | 'context'
    | 'integration_admission'
    | 'integration_landing'
    | 'mission_close';

export const CONTRACT_USE_PURPOSES: readonly ContractUsePurpose[] = [
    'dependency', 'handoff', 'context', 'integration_admission', 'integration_landing', 'mission_close',
];

export type ContractEligibilityState =
    | 'compat_open'
    | 'eligible'
    | 'waived'
    | 'held_missing_evidence'
    | 'needs_revalidation'
    | 'rejected_revoked'
    | 'rejected_ineligible_origin'
    | 'unavailable';

export interface ContractEligibility {
    state: ContractEligibilityState;
    /** Usable for the asked purpose right now. */
    usable: boolean;
    /** Content-free reason codes. */
    reasons: string[];
    resultKey?: string;
    namespaceId?: string;
    vector?: ContractHeadVector;
}

/**
 * Content-free refusal codes. Errors never echo secrets, prose or paths
 * (F10). `detail` strings built from these must stay inside this allowlist.
 */
export type ContractRefusalCode =
    | 'unauthenticated'
    | 'not_owner'
    | 'not_authorized'
    | 'capability_invalid'
    | 'capability_expired'
    | 'capability_revoked'
    | 'scope_mismatch'
    | 'not_enrolled'
    | 'already_enrolled'
    | 'authority_paused'
    | 'authority_requires_recovery'
    | 'head_conflict'
    | 'idempotency_conflict'
    | 'review_missing'
    | 'review_stale'
    | 'review_not_independent'
    | 'impact_requires_owner'
    | 'proposal_not_open'
    | 'proposal_not_found'
    | 'invalid_source'
    | 'source_unavailable'
    | 'source_digest_mismatch'
    | 'budget_exceeded'
    | 'quota_exceeded'
    | 'use_guard_conflict'
    | 'binding_not_active'
    | 'binding_missing'
    | 'unit_not_pinned'
    | 'no_full_receipt'
    | 'pin_block_over_budget'
    | 'strict_participant_unsupported'
    | 'store_version_unsupported'
    | 'ineligible_origin'
    | 'revoked'
    | 'vector_mismatch'
    | 'waiver_not_allowed'
    | 'invalid_input'
    | 'not_found'
    | 'unavailable';

export class ContractRefusal extends Error {
    readonly code: ContractRefusalCode;
    readonly current?: ContractHeadVector;
    constructor(code: ContractRefusalCode, opts: { current?: ContractHeadVector } = {}) {
        super(`contract_refused:${code}`);
        this.name = 'ContractRefusal';
        this.code = code;
        if (opts.current) this.current = opts.current;
    }
}

export function isContractRefusal(e: unknown): e is ContractRefusal {
    return e instanceof ContractRefusal;
}

/** Clock + randomness seams so tests are deterministic. */
export interface ContractRuntime {
    nowMs(): number;
    randomBytes(n: number): Buffer;
}
