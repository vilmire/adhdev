/**
 * seqscribe topic table — the single source for every topic ADHDev defines.
 *
 * Phase 0 of the seqscribe integration (the 2026-08-26 seqscribe integration plan §1).
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

/**
 * Per-session keyed chat transcript (design 2026-09-28 message-keyed storage
 * §4.1). One row per changed bubble/part plus a small `meta` and a per-frame
 * `commit`, newest-per-key compacted — see `sessionChatPolicy`.
 *
 * The earlier `session.<id>.transcript` whole-snapshot revision topic was
 * removed in the same change (§6); its leftover rows are deleted by
 * `writer-gc.ts`'s boot sweep, which recognizes that name on its own.
 */
export function sessionChatTopic(sessionId: string): string {
    return `session.${safeSessionId(sessionId)}.chat`;
}

/**
 * Recover the sanitized session segment from `session.<seg>.chat`, or null if
 * `topic` is not a session chat topic. Returns the SANITIZED segment (see the
 * caveat on `meshIdFromEventsTopic`) — compare topic names, never raw ids.
 */
export function sessionSegmentFromChatTopic(topic: string): string | null {
    if (!topic.startsWith('session.') || !topic.endsWith('.chat')) return null;
    const segment = topic.slice('session.'.length, -'.chat'.length);
    if (segment.length === 0 || segment.includes('.')) return null;
    return segment;
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

/** Replicated settings register (Phase 5 — key whitelist enforced separately). */
export const CONFIG_SETTINGS_TOPIC = 'config.settings';

// ─── Policies ───────────────────────────────────────────────────────────────

/**
 * `mesh.<id>.events` — metadata class ON PURPOSE.
 *
 * This is the one topic a cloud peer may hold (design §7: a metadata-class
 * Durable Object peer relaying vectors is the eventual answer to non-overlapping
 * online windows). That is only sound because mesh events are routing/lifecycle
 * records — ids, enums, counters — and never chat content. The §6.1 rule that
 * forbids secrets in any payload applies here with the least slack.
 *
 * Bounded by `writer-gc.ts` §3 (acknowledged retention, seqscribe host-guide
 * §4.8): rows older than 30 days that every mesh peer has acknowledged are
 * deleted, and a peer below that floor recovers with TRUNCATED. No policy
 * field is involved — `pruneAcked` is a host call — so nothing here changes
 * `topicSchemaHash`.
 */
export function meshEventsPolicy(): TopicPolicy {
    return {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'full-sync',
        access: 'metadata',
    };
}

/**
 * `mesh.<id>.handoff` — content-class text a mesh turn entry links to by `ref`
 * (turn summaries, `appendMeshHandoff`); full history, full-sync.
 *
 * Worker handoff NOTES are no longer written here (2026-09-29): they live only
 * in `mesh_handoff_note_text` (SQLite, 30-day retention) — nothing ever read
 * them back from the topic.
 *
 * ★`full-sync`, so the library refuses `pruneTopic` on it (a local prune would
 * leave a false gap for a peer syncing below the floor). It is bounded like
 * the events topic, by `writer-gc.ts` §3's acknowledged retention (30 days,
 * every peer acknowledged, TRUNCATED for a peer below the floor) — its turn
 * summaries are only ever resolved through refs on events entries of the same
 * age, and the resolver tolerates a missing entry (a pointer line).
 *
 * ★Content class, so it never reaches a metadata-only cloud peer: the text
 * stays on daemons and decision C needs no exception to the server content
 * boundary.
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

/** Tombstone kind of the keyed chat topic (a deleted bubble, part or key). */
export const CHAT_TOMBSTONE_KIND = 'chat.del.v2';

/**
 * `session.<id>.chat` — chat content, keyed append (design 2026-09-28 §4.1).
 *
 * `kind:'append'` + `keyed`: every entry carries a key (`m:<messageId>`,
 * `p:<messageId>:<k>`, `meta`, `commit`), the newest row per key is that key's
 * value, and a `chat.del.v2` row deletes it. Only CHANGED bubbles are written
 * per observation, so a streaming tick costs one bubble (or one 24 KiB part)
 * plus a commit, independent of the transcript's size.
 *
 * - `retention:'full'` + `subscribe-only`: durable across a restart; peers
 *   stream the `tail` SUB, whose SNAP for a keyed topic is newest-per-key
 *   (the host selector in `transcript-tail-snapshot.ts` pins it to the last
 *   commit). A `full` grant on a subscribe-only topic is a host error the
 *   library rejects — grant `serve`.
 * - Bounded by the producer's own `pruneSuperseded` after each commit and by
 *   `writer-gc.ts`'s safety-net sweep, not by `pruneTopic` (which would drop
 *   live keys).
 * - `keyed` is a LOCAL storage policy: like retention and replication it is
 *   not part of `topicSchemaHash`, and `kind`/`finalityAuthority` match the
 *   removed `.transcript` topic, so no coordinated fleet upgrade is needed
 *   (host-guide §6). Both ends — daemon and the web worker's
 *   `topic-addressing.ts` — must still define it identically.
 * - `access:'content'`: never granted to a metadata-class peer.
 */
export function sessionChatPolicy(): TopicPolicy {
    return {
        kind: 'append',
        keyed: { tombstoneKind: CHAT_TOMBSTONE_KIND },
        retention: { mode: 'full' },
        replication: 'subscribe-only',
        access: 'content',
        finalityAuthority: ADHDEV_AUTHORITY_ID,
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
 * Per-session chat topics are deliberately absent: they are defined on
 * demand as sessions appear (Phase 4), since policies are immutable per
 * process and a session set is not known at boot.
 */
export function baseTopicDefinitions(meshIds: readonly string[]): TopicDefinition[] {
    const defs: TopicDefinition[] = [
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
        // per-session chat topics above, which are not.
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
