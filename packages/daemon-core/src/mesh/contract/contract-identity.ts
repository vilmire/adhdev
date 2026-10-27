/**
 * Contract versioning — canonical, domain-separated identities (design §3).
 *
 * Every identity is SHA-256 over a domain tag plus a length-prefixed canonical
 * encoding with explicit UTF-8 byte lengths, so no two differently shaped
 * values can encode to the same bytes and no stable-label or JSON-whitespace
 * accident can change an id. Human version labels are aliases only and never
 * enter an identity used for authorization or caching.
 */

import { createHash } from 'node:crypto';
import type { ContractRevisionManifest, ContractUnitManifestEntry, ContractSourceEntry, ContractResultRef } from './contract-types.js';

type Canonical = null | boolean | number | string | Canonical[] | { [k: string]: Canonical | undefined };

/** Length-prefixed canonical encoding. Integers only; object keys sorted by UTF-8 bytes; undefined keys dropped. */
export function encodeCanonical(value: Canonical): Buffer {
    const parts: Buffer[] = [];
    const walk = (v: Canonical | undefined): void => {
        if (v === null || v === undefined) { parts.push(Buffer.from('n')); return; }
        if (typeof v === 'boolean') { parts.push(Buffer.from(v ? 't' : 'f')); return; }
        if (typeof v === 'number') {
            if (!Number.isSafeInteger(v)) throw new Error('canonical_non_integer');
            parts.push(Buffer.from(`i${v};`));
            return;
        }
        if (typeof v === 'string') {
            const b = Buffer.from(v, 'utf8');
            parts.push(Buffer.from(`s${b.length}:`), b);
            return;
        }
        if (Array.isArray(v)) {
            parts.push(Buffer.from(`a${v.length}:`));
            for (const item of v) walk(item);
            return;
        }
        const keys = Object.keys(v).filter(k => v[k] !== undefined)
            .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
        parts.push(Buffer.from(`o${keys.length}:`));
        for (const k of keys) { walk(k); walk(v[k]); }
    };
    walk(value);
    return Buffer.concat(parts);
}

/** Domain-separated digest: `adhdev.contract/<tag>/v1 \0 <canonical bytes>`. */
export function domainDigest(tag: string, value: Canonical): string {
    return createHash('sha256')
        .update(`adhdev.contract/${tag}/v1\u0000`, 'utf8')
        .update(encodeCanonical(value))
        .digest('hex');
}

export function sha256Bytes(bytes: Buffer | Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function sourceCanonical(s: ContractSourceEntry): Canonical {
    return {
        repoBindingId: s.repoBindingId,
        hashAlgorithm: s.hashAlgorithm,
        commitOid: s.commitOid,
        gitlinks: s.gitlinks.map(g => ({ path: g.path, childRepoBindingId: g.childRepoBindingId, childCommitOid: g.childCommitOid })),
        path: s.path,
        blobOid: s.blobOid,
        mode: s.mode,
        byteLength: s.byteLength,
        sha256: s.sha256,
    };
}

function unitCanonical(u: ContractUnitManifestEntry): Canonical {
    return {
        unitId: u.unitId,
        digest: u.digest,
        byteLength: u.byteLength,
        mediaType: u.mediaType,
        normativeType: u.normativeType,
        applicationApiVersion: u.applicationApiVersion,
        dependsOn: [...u.dependsOn].sort(),
        roles: [...u.roles].sort(),
        sources: u.sources.map(sourceCanonical),
    };
}

/** Normalize a manifest so the same content always yields the same canonical shape. */
export function normalizeManifest(m: ContractRevisionManifest): ContractRevisionManifest {
    return {
        schema: m.schema,
        namespaceId: m.namespaceId,
        predecessorRevisionId: m.predecessorRevisionId,
        impact: m.impact,
        units: [...m.units]
            .map(u => ({ ...u, dependsOn: [...u.dependsOn].sort(), roles: [...u.roles].sort() }))
            .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
    };
}

export function manifestCanonical(m: ContractRevisionManifest): Canonical {
    const n = normalizeManifest(m);
    return {
        schema: n.schema,
        namespaceId: n.namespaceId,
        predecessorRevisionId: n.predecessorRevisionId,
        impact: n.impact,
        units: n.units.map(unitCanonical),
    };
}

/** revisionId = domain digest of the canonical manifest. Reviews/acceptance are separate envelopes. */
export function computeRevisionId(m: ContractRevisionManifest): string {
    return `rev_${domainDigest('revision', manifestCanonical(m))}`;
}

export interface PinEntry { revisionId: string; unitId: string; unitDigest: string; byteLength: number }

export function computePinSetDigest(input: {
    namespaceId: string;
    authorityEpoch: number;
    headGeneration: number;
    policyRevision: number;
    pins: PinEntry[];
}): string {
    return `pin_${domainDigest('pinset', {
        namespaceId: input.namespaceId,
        authorityEpoch: input.authorityEpoch,
        headGeneration: input.headGeneration,
        policyRevision: input.policyRevision,
        pins: [...input.pins]
            .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))
            .map(p => ({ revisionId: p.revisionId, unitId: p.unitId, unitDigest: p.unitDigest, byteLength: p.byteLength })),
    })}`;
}

export function resultKeyOf(r: ContractResultRef): string {
    return `res_${domainDigest('result', {
        meshId: r.meshId, taskId: r.taskId, attemptId: r.attemptId,
        generation: r.generation, outputVersion: r.outputVersion, payloadDigest: r.payloadDigest,
    })}`;
}

/**
 * Semantic notice identity (design §11). toRevision alone fails ABA R1→R2→R1;
 * epoch + head generation distinguish every acceptance event.
 */
export function computeNoticeKey(input: {
    namespaceId: string; authorityEpoch: number; headGeneration: number; toRevisionId: string | null;
    taskId: string; attemptId: string; generation: number; bindingId: string; noticeClass: string;
}): string {
    return `ntc_${domainDigest('notice', { ...input })}`;
}

export function digestOfRequest(tag: string, value: Canonical): string {
    return domainDigest(`request/${tag}`, value);
}

export type { Canonical };
