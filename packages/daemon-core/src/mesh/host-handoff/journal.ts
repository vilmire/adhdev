/**
 * Durable phase journal of a host handoff (design §7.2). Every phase change is
 * written BEFORE the effect it announces, so a crash at any point resumes from
 * the last journalled phase. The SQLite implementation backs the daemon; the
 * in-memory one backs the in-process tests (and survives a simulated "crash"
 * because the test keeps the object while discarding the engine).
 */

import type { HandoffManifest, HandoffRecord, HandoffRole, HostTransferCertificate } from './types.js';

export interface HandoffJournal {
    get(handoffId: string, role: HandoffRole): HandoffRecord | null;
    /** The unfinished record (non-terminal) of a mesh+role, if any. */
    findActive(meshId: string, role: HandoffRole): HandoffRecord | null;
    put(record: HandoffRecord): void;
    update(handoffId: string, role: HandoffRole, patch: Partial<HandoffRecord>): HandoffRecord;
    list(meshId?: string): HandoffRecord[];
    /** Target staging. */
    putManifest(handoffId: string, manifest: HandoffManifest): void;
    getManifest(handoffId: string): HandoffManifest | null;
    putCertificate(handoffId: string, certificate: HostTransferCertificate): void;
    getCertificate(handoffId: string): HostTransferCertificate | null;
    putChunk(handoffId: string, seq: number, sha256: string, data: string): void;
    getChunks(handoffId: string): Array<{ seq: number; sha256: string; data: string }>;
    clearStage(handoffId: string): void;
}

const TERMINAL: Record<HandoffRole, ReadonlySet<string>> = {
    source: new Set(['committed', 'aborted']),
    target: new Set(['active', 'discarded']),
};

export function isTerminalPhase(role: HandoffRole, phase: string): boolean {
    return TERMINAL[role].has(phase);
}

export class MemoryHandoffJournal implements HandoffJournal {
    private readonly records = new Map<string, HandoffRecord>();
    private readonly manifests = new Map<string, HandoffManifest>();
    private readonly certificates = new Map<string, HostTransferCertificate>();
    private readonly chunks = new Map<string, Map<number, { sha256: string; data: string }>>();
    private key(id: string, role: HandoffRole): string { return `${id}\0${role}`; }
    get(id: string, role: HandoffRole) { const r = this.records.get(this.key(id, role)); return r ? { ...r } : null; }
    findActive(meshId: string, role: HandoffRole) {
        for (const r of this.records.values()) if (r.meshId === meshId && r.role === role && !isTerminalPhase(role, r.phase)) return { ...r };
        return null;
    }
    put(record: HandoffRecord) { this.records.set(this.key(record.handoffId, record.role), { ...record }); }
    update(id: string, role: HandoffRole, patch: Partial<HandoffRecord>) {
        const cur = this.records.get(this.key(id, role));
        if (!cur) throw new Error(`handoff ${id} (${role}) not journalled`);
        const next = { ...cur, ...patch };
        this.records.set(this.key(id, role), next);
        return { ...next };
    }
    list(meshId?: string) { return [...this.records.values()].filter(r => !meshId || r.meshId === meshId).map(r => ({ ...r })); }
    putManifest(id: string, m: HandoffManifest) { this.manifests.set(id, structuredClone(m)); }
    getManifest(id: string) { const m = this.manifests.get(id); return m ? structuredClone(m) : null; }
    putCertificate(id: string, certificate: HostTransferCertificate) { this.certificates.set(id, structuredClone(certificate)); }
    getCertificate(id: string) { const c = this.certificates.get(id); return c ? structuredClone(c) : null; }
    putChunk(id: string, seq: number, sha256: string, data: string) {
        let m = this.chunks.get(id); if (!m) this.chunks.set(id, m = new Map());
        m.set(seq, { sha256, data });
    }
    getChunks(id: string) { return [...(this.chunks.get(id) ?? new Map()).entries()].map(([seq, v]) => ({ seq, ...v })).sort((a, b) => a.seq - b.seq); }
    clearStage(id: string) { this.chunks.delete(id); this.manifests.delete(id); }
}

type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }; transaction<T>(fn: () => T): () => T };

interface Row {
    handoff_id: string; role: HandoffRole; mesh_id: string; peer_daemon_id: string; phase: string; epoch: number;
    manifest_digest: string | null; row_counts_json: string | null; target_node_id: string | null;
    created_at: number; updated_at: number; abort_reason: string | null; commit_intent_at: number | null;
    probe_count: number | null; last_probe_at: number | null; target_public_key: string | null;
}

function fromRow(r: Row): HandoffRecord {
    return {
        handoffId: r.handoff_id, role: r.role, meshId: r.mesh_id, peerDaemonId: r.peer_daemon_id,
        phase: r.phase as HandoffRecord['phase'], epoch: r.epoch,
        ...(r.manifest_digest ? { manifestDigest: r.manifest_digest } : {}),
        ...(r.row_counts_json ? { rowCounts: JSON.parse(r.row_counts_json) as Record<string, number> } : {}),
        ...(r.target_node_id ? { targetNodeId: r.target_node_id } : {}),
        createdAt: r.created_at, updatedAt: r.updated_at,
        ...(r.abort_reason ? { abortReason: r.abort_reason } : {}),
        ...(r.commit_intent_at !== null ? { commitIntentAt: r.commit_intent_at } : {}),
        ...(r.probe_count !== null ? { probeCount: r.probe_count } : {}),
        ...(r.last_probe_at !== null ? { lastProbeAt: r.last_probe_at } : {}),
        ...(r.target_public_key ? { targetPublicKey: r.target_public_key } : {}),
    };
}

export class SqliteHandoffJournal implements HandoffJournal {
    constructor(private readonly db: Db) {}
    get(id: string, role: HandoffRole) {
        const r = this.db.prepare('SELECT * FROM mesh_host_handoff WHERE handoff_id = ? AND role = ?').get(id, role) as Row | undefined;
        return r ? fromRow(r) : null;
    }
    findActive(meshId: string, role: HandoffRole) {
        const rows = this.db.prepare('SELECT * FROM mesh_host_handoff WHERE mesh_id = ? AND role = ? ORDER BY updated_at DESC').all(meshId, role) as Row[];
        const hit = rows.find(r => !isTerminalPhase(role, r.phase));
        return hit ? fromRow(hit) : null;
    }
    put(r: HandoffRecord) {
        this.db.prepare(`INSERT INTO mesh_host_handoff (handoff_id, role, mesh_id, peer_daemon_id, phase, epoch, manifest_digest, row_counts_json, target_node_id, created_at, updated_at, abort_reason, commit_intent_at, probe_count, last_probe_at, target_public_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(handoff_id, role) DO UPDATE SET mesh_id=excluded.mesh_id, peer_daemon_id=excluded.peer_daemon_id, phase=excluded.phase, epoch=excluded.epoch,
              manifest_digest=excluded.manifest_digest, row_counts_json=excluded.row_counts_json, target_node_id=excluded.target_node_id, updated_at=excluded.updated_at,
              abort_reason=excluded.abort_reason, commit_intent_at=excluded.commit_intent_at, probe_count=excluded.probe_count, last_probe_at=excluded.last_probe_at, target_public_key=excluded.target_public_key`)
            .run(r.handoffId, r.role, r.meshId, r.peerDaemonId, r.phase, r.epoch, r.manifestDigest ?? null, r.rowCounts ? JSON.stringify(r.rowCounts) : null,
                r.targetNodeId ?? null, r.createdAt, r.updatedAt, r.abortReason ?? null, r.commitIntentAt ?? null, r.probeCount ?? null, r.lastProbeAt ?? null, r.targetPublicKey ?? null);
    }
    update(id: string, role: HandoffRole, patch: Partial<HandoffRecord>) {
        const cur = this.get(id, role);
        if (!cur) throw new Error(`handoff ${id} (${role}) not journalled`);
        const next = { ...cur, ...patch };
        this.put(next);
        return next;
    }
    list(meshId?: string) {
        const rows = (meshId
            ? this.db.prepare('SELECT * FROM mesh_host_handoff WHERE mesh_id = ? ORDER BY created_at').all(meshId)
            : this.db.prepare('SELECT * FROM mesh_host_handoff ORDER BY created_at').all()) as Row[];
        return rows.map(fromRow);
    }
    putManifest(id: string, m: HandoffManifest) {
        this.db.prepare('INSERT INTO mesh_host_handoff_manifest (handoff_id, manifest_json) VALUES (?, ?) ON CONFLICT(handoff_id) DO UPDATE SET manifest_json = excluded.manifest_json').run(id, JSON.stringify(m));
    }
    getManifest(id: string) {
        const r = this.db.prepare('SELECT manifest_json FROM mesh_host_handoff_manifest WHERE handoff_id = ?').get(id) as { manifest_json: string } | undefined;
        return r ? JSON.parse(r.manifest_json) as HandoffManifest : null;
    }
    putCertificate(id: string, certificate: HostTransferCertificate) {
        this.db.prepare('INSERT INTO mesh_host_handoff_certificate (handoff_id, certificate_json) VALUES (?, ?) ON CONFLICT(handoff_id) DO UPDATE SET certificate_json = excluded.certificate_json').run(id, JSON.stringify(certificate));
    }
    getCertificate(id: string) {
        const r = this.db.prepare('SELECT certificate_json FROM mesh_host_handoff_certificate WHERE handoff_id = ?').get(id) as { certificate_json: string } | undefined;
        return r ? JSON.parse(r.certificate_json) as HostTransferCertificate : null;
    }
    putChunk(id: string, seq: number, sha256: string, data: string) {
        this.db.prepare('INSERT INTO mesh_host_handoff_stage (handoff_id, seq, sha256, data) VALUES (?,?,?,?) ON CONFLICT(handoff_id, seq) DO UPDATE SET sha256 = excluded.sha256, data = excluded.data').run(id, seq, sha256, data);
    }
    getChunks(id: string) {
        return (this.db.prepare('SELECT seq, sha256, data FROM mesh_host_handoff_stage WHERE handoff_id = ? ORDER BY seq').all(id) as Array<{ seq: number; sha256: string; data: string }>);
    }
    clearStage(id: string) {
        this.db.prepare('DELETE FROM mesh_host_handoff_stage WHERE handoff_id = ?').run(id);
        this.db.prepare('DELETE FROM mesh_host_handoff_manifest WHERE handoff_id = ?').run(id);
    }
}
