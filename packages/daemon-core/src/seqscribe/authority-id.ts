/**
 * The fleet's finality authority id — isolated here on purpose.
 *
 * This is a bare string constant, but it is part of `topicSchemaHash` (see
 * topics.ts), so the topic TABLE must be able to name it. Keeping it in
 * authority.ts made the table transitively depend on the signing runtime,
 * which imports the logger, which resolves the daemon config dir AT MODULE
 * LOAD. That turned "read the topic policy table" into a side effect: any
 * consumer that only wanted the policy shape — notably web-core's parity test,
 * which compares the browser policy against this table's real
 * `sessionTranscriptPolicy` — had to have a live/pinned ADHDEV_CONFIG_DIR or it
 * died during import.
 *
 * So this module has, and must keep, ZERO imports. topics.ts reads the id from
 * here; authority.ts re-exports it so every existing importer (and the
 * daemon-core public barrel) is unchanged.
 *
 * Stable string, not a machine id: the coordinator daemon that holds the role
 * can change hosts without a schema change. Changing THIS value is a fleet
 * upgrade (host-guide §6) — every peer refuses the topic until all converge.
 */
export const ADHDEV_AUTHORITY_ID = 'adhdev-coordinator';
