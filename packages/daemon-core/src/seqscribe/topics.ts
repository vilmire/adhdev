/**
 * seqscribe topic table — the single source for every topic ADHDev defines.
 *
 * Phase 0 of the seqscribe integration (docs/design/2026-08-26-seqscribe-integration-plan.md §1).
 * Nothing here consumes a topic yet; later phases attach producers/consumers to
 * these names. Keeping the table in one module means a policy change is a
 * one-line diff rather than a fleet-wide grep — which matters because several
 * of these fields are part of `topicSchemaHash` and therefore a COORDINATED
 * FLEET UPGRADE, not a rolling deploy (seqscribe host-guide §6):
 *
 *   conflict policy (default + overrides) · finalityAuthority id · topic kind
 *
 * Grants, retention, replication and access are NOT hashed, but changing them
 * still deserves fleet coordination for operational sanity.
 *
 * ── Which policies carry `finalityAuthority` ────────────────────────────────
 * The three CONTENT policies do: `proposeFinality` throws and certificate
 * ingestion rejects (`bad_cert`) unless the policy names the authority, and the
 * id is inside `topicSchemaHash` — so it is one constant (`ADHDEV_AUTHORITY_ID`)
 * fleet-wide, and a node without the fleet secret cannot even DEFINE these
 * topics (the library requires `verifyFinality`; node.ts skips them in
 * provisional mode). The two metadata policies deliberately carry none: their
 * authority is a Phase 6 cloud promotion, and until then metadata topics sync
 * on any node, secret or not.
 *
 * ── Access class is a security boundary, not a hint ────────────────────────
 * `access: 'content'` topics may only ever be granted to peers we trust with
 * arbitrary writes under any writerId (host-guide §1: "granting full on a
 * topic = trusting that peer to write arbitrary content under any writerId").
 * `access: 'metadata'` topics are the only ones a cloud relay may hold. The
 * library refuses to attach a content topic to a metadata-class peer, but the
 * classification decision below is ours.
 */

import type { TopicPolicy } from 'seqscribe';
import { ADHDEV_AUTHORITY_ID } from './authority-id.js';

// Imported from authority-id.ts, NOT authority.ts. That module is zero-import
// by construction, which keeps this table side-effect-free at load: authority.ts
// pulls in the logger, and the logger resolves the daemon config dir at module
// load, so importing the id from there would make merely READING a topic policy
// require a live (or test-pinned) ADHDEV_CONFIG_DIR. Keep it pointed here.

// ─── Charter normalization ──────────────────────────────────────────────────

/**
 * seqscribe's topic charter (`TOPIC_RE = /^[a-z0-9_.-]{1,128}$/`) is stricter
 * than the ids ADHDev mints:
 *   - it is LOWERCASE-only, while session/instance keys can carry uppercase
 *   - it excludes `:`, which appears in IDE instance keys (`ide:cursor-1`)
 *   - `.` is the topic path separator, so an id containing `.` would silently
 *     invent a new topic segment
 *
 * So every id interpolated into a topic name goes through a sanitizer first.
 * These are deliberately NOT reversible: the topic name is an addressing label,
 * and the authoritative id always travels inside the entry payload.
 */
const TOPIC_SEGMENT_UNSAFE = /[^a-z0-9_-]+/g;

function sanitizeSegment(raw: string, fallback: string): string {
    const cleaned = raw.toLowerCase().replace(TOPIC_SEGMENT_UNSAFE, '_').replace(/^_+|_+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

/**
 * Normalize a meshId (`mesh_<32 hex>`) into a topic segment.
 *
 * Already-charter-safe ids pass through unchanged, so the common case produces
 * exactly `mesh.mesh_<hex>.events` and stays greppable against `meshes.json`.
 */
export function safeMeshId(meshId: string): string {
    return sanitizeSegment(meshId, 'unknown_mesh');
}

/** Normalize a session id into a topic segment. See `safeMeshId`. */
export function safeSessionId(sessionId: string): string {
    return sanitizeSegment(sessionId, 'unknown_session');
}

// ─── Topic names ────────────────────────────────────────────────────────────

/** Mesh event log for one mesh — the Phase 2 replacement for `mesh-ledger/*.jsonl`. */
export function meshEventsTopic(meshId: string): string {
    return `mesh.${safeMeshId(meshId)}.events`;
}

/**
 * Recover the mesh segment from a mesh events topic, or null if not one.
 *
 * ★ Returns the SANITIZED segment, not necessarily the original meshId —
 * `safeMeshId` is not injective (two ids differing only in charter-unsafe
 * characters collapse to one segment). That is fine for the callers that have
 * it (diagnostics, per-topic housekeeping) and wrong for anything that would
 * feed the result back into an id comparison — use the topic itself as the key
 * there, never this.
 */
export function meshIdFromEventsTopic(topic: string): string | null {
    if (!topic.startsWith('mesh.') || !topic.endsWith('.events')) return null;
    const segment = topic.slice('mesh.'.length, -'.events'.length);
    // A nested dot would mean this is some other `mesh.*.…` topic shape.
    if (segment.length === 0 || segment.includes('.')) return null;
    return segment;
}

/** Cross-daemon assistant journal — the Phase 1 greenfield consumer. */
export const ASSISTANT_JOURNAL_TOPIC = 'assistant.journal';

/** Per-session chat transcript tail (Phase 4). */
export function sessionTranscriptTopic(sessionId: string): string {
    return `session.${safeSessionId(sessionId)}.transcript`;
}

/**
 * Per-mesh worker handoff notes (worker-MCP decision C / F).
 *
 * ★Deliberately NOT `mesh.<id>.events`. That topic is metadata class precisely
 * so a cloud peer may hold it — "routing/lifecycle records, ids, enums,
 * counters, never chat content". A handoff note is free text an agent wrote
 * about why it changed code: content by any reading. Putting it on the events
 * topic would break that invariant and carry the text across the cloud boundary,
 * so it gets its own content-class topic instead.
 */
export function meshHandoffTopic(meshId: string): string {
    return `mesh.${safeMeshId(meshId)}.handoff`;
}

/** Fleet-wide daemon status tail (Phase 4). */
export const FLEET_STATUS_TOPIC = 'fleet.status';

/** Replicated settings register (Phase 5 — key whitelist enforced separately). */
export const CONFIG_SETTINGS_TOPIC = 'config.settings';

// ─── Policies ───────────────────────────────────────────────────────────────

/**
 * Ring size for a session transcript. Sized so a tail reload shows a useful
 * scrollback while keeping the per-session cost bounded — the ring is not the
 * transcript's system of record, it is the live tail.
 */
export const SESSION_TRANSCRIPT_RING = 500;

/** Ring size for the fleet status tail (design §1). */
export const FLEET_STATUS_RING = 50;

/**
 * `mesh.<id>.events` — metadata class ON PURPOSE.
 *
 * This is the one topic a cloud peer may hold (design §7: a metadata-class
 * Durable Object peer relaying vectors is the eventual answer to non-overlapping
 * online windows). That is only sound because mesh events are routing/lifecycle
 * records — ids, enums, counters — and never chat content. The §6.1 rule that
 * forbids secrets in any payload applies here with the least slack.
 */
export function meshEventsPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'full-sync',
        access: 'metadata',
    };
}

/** `assistant.journal` — content class; full history, offline-durable. */
export function assistantJournalPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'full-sync',
        access: 'content',
        // Content topics name the fleet authority (see the header note on
        // finalityAuthority): required for proposeFinality/cert ingestion, and
        // inside topicSchemaHash, so this is one constant fleet-wide.
        finalityAuthority: ADHDEV_AUTHORITY_ID,
    };
}

/**
 * `mesh.<id>.handoff` — worker handoff notes; content class, full history.
 *
 * `full` retention rather than a ring, unlike the session transcript: a note's
 * whole purpose is to be read by work that has not been dispatched yet, which
 * can be days later. A ring would silently evict exactly the older notes a
 * long-running mission most needs. Volume is bounded in practice by shape —
 * at most one note per completed task, not one per message.
 *
 * `full-sync` so a worker on another machine in the same mesh can receive a
 * note written here; that is the cross-node handoff case the feature exists for.
 *
 * ★Content class, so it never reaches a metadata-only cloud peer. That is what
 * lets decision C avoid asking for a new exception to the server content
 * boundary: the note text stays on daemons.
 */
export function meshHandoffPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'full-sync',
        access: 'content',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
    };
}

/**
 * `session.<id>.transcript` — chat content, so a bounded ring rather than full
 * history, and `subscribe-only`: peers stream the tail instead of negotiating
 * mutual full-sync. NOTE a `full` grant on a subscribe-only topic is a host
 * error the library rejects (seqscribe proposals-v3.5 P1) — grant `serve`.
 */
export function sessionTranscriptPolicy(ringSize: number = SESSION_TRANSCRIPT_RING): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'ring', size: ringSize },
        replication: 'subscribe-only',
        access: 'content',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
    };
}

/** `fleet.status` — status counters only; ring tail, metadata class. */
export function fleetStatusPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'ring', size: FLEET_STATUS_RING },
        replication: 'subscribe-only',
        access: 'metadata',
    };
}

/**
 * `config.settings` — a register, not an append log.
 *
 * Conflict policy (design §6.3), all of it inside `topicSchemaHash`:
 *   - default `lww`   — fleet-common settings; last writer wins
 *   - `machine.*`     — `owned`: only the owning machine writes its own profile,
 *                       because two machines racing on `machine.<id>.workspaces`
 *                       is never a merge, it is one of them being wrong
 *   - `security.*`    — `fww`: first write wins, so a later peer cannot silently
 *                       relax a security setting by writing last
 *
 * `owned` requires `verifyTakeover` + `verifyWriterDirective` to be configured
 * before defineTopic, or the library throws — see authority.ts. The
 * `finalityAuthority` below likewise requires `verifyFinality`, so this topic
 * cannot be defined at all without the fleet secret (node.ts skips it in
 * provisional mode).
 *
 * ★ §6.1: this topic replicates to the whole fleet. Secrets and machine
 * identity must never reach it. Phase 5 adds the key whitelist that enforces
 * this; Phase 0 only declares the shape.
 */
export function configSettingsPolicy(): TopicPolicy {
    return {
        kind: 'register',
        retention: { mode: 'full' },
        replication: 'full-sync',
        access: 'content',
        // P27 derives pre-write hints directly from the register fold. Hash
        // mode keeps authored setting keys off the Beacon board.
        hintKeys: 'hash',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
        conflict: {
            default: 'lww',
            overrides: {
                'machine.*': 'owned',
                'security.*': 'fww',
            },
        },
    };
}

// ─── Registration set ───────────────────────────────────────────────────────

export interface TopicDefinition {
    topic: string;
    policy: TopicPolicy;
}

/**
 * The topics every daemon defines at boot.
 *
 * Per-session transcript topics are deliberately absent: they are defined
 * on demand as sessions appear (Phase 4), since policies are immutable per
 * process and a session set is not known at boot.
 */
export function baseTopicDefinitions(meshIds: readonly string[]): TopicDefinition[] {
    const defs: TopicDefinition[] = [
        { topic: ASSISTANT_JOURNAL_TOPIC, policy: assistantJournalPolicy() },
        { topic: FLEET_STATUS_TOPIC, policy: fleetStatusPolicy() },
        { topic: CONFIG_SETTINGS_TOPIC, policy: configSettingsPolicy() },
    ];
    // De-dupe: two meshIds that differ only outside the charter alphabet
    // normalize to the same topic, and defineTopic on a duplicate throws.
    const seen = new Set<string>();
    for (const meshId of meshIds) {
        const topic = meshEventsTopic(meshId);
        if (seen.has(topic)) continue;
        seen.add(topic);
        defs.push({ topic, policy: meshEventsPolicy() });
        // Worker handoff notes for the same mesh. Registered at boot alongside
        // the events topic because the mesh set IS known at boot — unlike the
        // per-session transcript topics above, which are not.
        defs.push({ topic: meshHandoffTopic(meshId), policy: meshHandoffPolicy() });
    }
    return defs;
}

/**
 * Topics whose finality the coordinator certifies. Content topics only —
 * a metadata-class peer cannot certify a content topic (host-guide §2), and
 * metadata-topic authority is a Phase 6 cloud promotion.
 */
export function contentTopicsFor(defs: readonly TopicDefinition[]): string[] {
    return defs.filter((d) => d.policy.access === 'content').map((d) => d.topic);
}
