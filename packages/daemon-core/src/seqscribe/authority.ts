/**
 * seqscribe finality authority — the coordinator daemon's signing role.
 *
 * Phase 0 of the seqscribe integration (design §1.4). An authority id is a
 * ROLE, not a machine (seqscribe host-guide §2): the coordinator daemon holds
 * it, and moving it is a coordinated fleet upgrade because `finalityAuthority`
 * is part of `topicSchemaHash`.
 *
 * ── What the authority actually does ───────────────────────────────────────
 * On a cadence: `proposeFinality(topic)` → sign → `ingestFinality(cert)`. The
 * library computes the cut; we only sign it. A `null` proposal means an empty
 * qualifying window and is correct silence, not an error.
 *
 * ── Secret handling (§6.1) ─────────────────────────────────────────────────
 * The HMAC secret is passed in by the caller and is NEVER persisted here, never
 * logged, and never placed in a topic payload. Persistence lives in
 * seqscribe/fleet-secret.ts (the `auth_ok` delivery path writes it there); this
 * module only resolves priority between the env var and that store.
 */

import type { AuthorityHooks, SeqscribeNode, Topic } from 'seqscribe';
import { hmacAuthority, startFinalityLoop } from 'seqscribe';
import type { FinalityLoopHandle, HmacAuthority } from 'seqscribe';
import { LOG } from '../logging/logger.js';

/**
 * Finality cadence. The design pins 1h (§1.4): frequent enough that the
 * watermark tracks reality for finalized-only consumers, cheap enough that a
 * sleeping fleet is not woken to certify nothing.
 */
export const FINALITY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The single authority id for the fleet.
 *
 * Defined in ./authority-id.ts (a zero-import module) and re-exported here so
 * this stays its canonical import site. The split exists so topics.ts can name
 * the id without dragging this module's logger/config-dir load-time chain into
 * every reader of the topic table — see authority-id.ts for the full reason.
 */
export { ADHDEV_AUTHORITY_ID } from './authority-id.js';
import { ADHDEV_AUTHORITY_ID } from './authority-id.js';

export interface FleetAuthorityOptions {
    /**
     * Shared fleet secret for HMAC-SHA256 signing. Must be identical on every
     * daemon that verifies certificates, and as private as the fleet itself.
     */
    secret: string;
    /** Override the authority id. Fleet-wide schema change — see above. */
    authorityId?: string;
    /**
     * Role binding: does this authority govern (topic, writer)? Without it any
     * valid signer could retire arbitrary writers (host-guide §2 — signature-only
     * verification is the classic hole). Default governs everything, which is
     * only safe because ADHDev runs a single-authority fleet.
     */
    governs?: (topic: Topic, writer: string) => boolean;
}

/**
 * Build the `AuthorityHooks` every node passes to `createSeqscribe`.
 *
 * Note this is needed on EVERY daemon, not just the coordinator: non-authority
 * nodes still have to VERIFY certificates and directives. Only the issuance
 * loop (`startFleetFinalityLoop`) is coordinator-only. It is also a hard
 * prerequisite for any `owned` register key — `defineTopic` throws on an
 * `owned` policy unless `verifyTakeover`/`verifyWriterDirective` exist, which
 * is exactly what `config.settings` uses for `machine.*`.
 */
export function createFleetAuthority(opts: FleetAuthorityOptions): HmacAuthority {
    if (!opts.secret) {
        // Fail loudly rather than signing with an empty key: an empty-secret
        // HMAC still verifies against itself, so a silent default would look
        // healthy while accepting certificates from anyone.
        throw new Error('seqscribe fleet authority requires a non-empty secret');
    }
    return hmacAuthority({
        authorityId: opts.authorityId ?? ADHDEV_AUTHORITY_ID,
        secret: opts.secret,
        governs: opts.governs,
    });
}

export interface FinalityLoopOptions {
    /** Content topics to certify. Metadata topics are a Phase 6 cloud promotion. */
    topics: Topic[];
    authority: Pick<HmacAuthority, 'signFinality'>;
    intervalMs?: number;
}

/**
 * Start the issuance loop. **Coordinator daemon only** — two hosts issuing
 * under one authority id race their `generation` counters against each other.
 *
 * Returns null when there is nothing to certify, so the caller can treat "no
 * loop" as a normal state rather than an error.
 */
export function startFleetFinalityLoop(
    node: SeqscribeNode,
    opts: FinalityLoopOptions,
): FinalityLoopHandle | null {
    if (opts.topics.length === 0) return null;
    return startFinalityLoop(node, {
        topics: opts.topics,
        authority: opts.authority,
        intervalMs: opts.intervalMs ?? FINALITY_INTERVAL_MS,
        onError: (topic, err) => {
            // Never throw out of the loop: one bad topic must not stop
            // certification for the rest, and the next tick retries.
            LOG.warn(
                'Seqscribe',
                `finality issuance failed for ${topic}: ${err instanceof Error ? err.message : String(err)}`,
            );
        },
    });
}

/**
 * Resolve the fleet secret, or null when the fleet has none configured.
 *
 * ── Why this is injection-only today ───────────────────────────────────────
 * The design (§1.4) says to reuse "the existing daemon-auth secret distribution
 * path" rather than invent a new channel. Surveying what actually exists:
 *
 *   - `config.machineSecret` (`adm_…`) is PER-MACHINE and is the server auth
 *     credential. It is not shared across the fleet, so it cannot key a fleet
 *     HMAC, and §6.1 forbids it leaving the machine in any case.
 *   - the mesh host pairing token (`mhj_…`) IS fleet-shared at join time, but
 *     `mesh-config` persists only `tokenId` — a short hash — never the raw
 *     token. It is a one-time join credential, not a retrievable secret.
 *
 * So no pre-existing store held a retrievable fleet-shared secret, and minting
 * one here would be exactly the "new secret channel" the design forbids. Phase 1
 * closed that gap: the server issues the fleet secret over the existing daemon
 * `auth_ok` handshake and daemon-cloud persists it via seqscribe/fleet-secret.ts;
 * this function takes that stored value as its second argument. "Absent" remains
 * authority-disabled: nodes still sync, and entries stay provisional (which
 * seqscribe already defines as the default consumer mode — host-guide §4).
 *
 * `ADHDEV_SEQSCRIBE_FLEET_SECRET` exists so a dogfooding fleet and the
 * integration tests can supply one without a config migration.
 *
 * ── Resolution priority (pinned by tests) ───────────────────────────────────
 *   1. `ADHDEV_SEQSCRIBE_FLEET_SECRET` env var — WINS when set (standalone and
 *      test determinism: an explicit env must never be silently overridden by
 *      whatever the server last delivered).
 *   2. `stored` — the secret the `auth_ok` handshake persisted via
 *      seqscribe/fleet-secret.ts (Phase 1 distribution path).
 *   3. null — provisional mode: nodes sync, entries never finalize.
 *
 * Whitespace-only values are ignored at every level.
 */
export function resolveFleetSecret(
    env: NodeJS.ProcessEnv = process.env,
    stored?: string | null,
): string | null {
    const fromEnv = env.ADHDEV_SEQSCRIBE_FLEET_SECRET?.trim();
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    const fromStore = stored?.trim();
    return fromStore && fromStore.length > 0 ? fromStore : null;
}

/**
 * Build authority hooks if a secret is available, else null.
 *
 * A null return is a supported operating mode, not a failure: without an
 * authority nothing certifies finality, so the log never advances a watermark
 * and every consumer stays provisional. What it does NOT support is any policy
 * that names a `finalityAuthority` or uses an `owned` register key — the library
 * throws from `defineTopic` in both cases — which is why `node.ts` degrades to
 * metadata-topics-only when the authority is absent instead of failing the boot.
 */
export function createFleetAuthorityIfConfigured(
    env: NodeJS.ProcessEnv = process.env,
    stored?: string | null,
): { authority: HmacAuthority; hooks: AuthorityHooks } | null {
    const secret = resolveFleetSecret(env, stored);
    if (!secret) return null;
    const authority = createFleetAuthority({ secret });
    return { authority, hooks: authority };
}
