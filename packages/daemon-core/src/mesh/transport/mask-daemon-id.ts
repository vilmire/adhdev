/**
 * Log-safe abbreviation of a mesh daemon id.
 *
 * Mesh daemon ids are prefixed (`daemon_mach_<hex>`, `mach_<hex>`,
 * `standalone_mach_<hex>`). A naive `id.slice(0, 12)` therefore yields a constant
 * — every `daemon_mach_*` node abbreviates to the literal `daemon_mach_`, which
 * makes per-node attribution impossible in exactly the logs you reach for when
 * diagnosing a single misbehaving peer.
 *
 * This strips the known prefix first and abbreviates the *discriminating* suffix,
 * so two different nodes never render identically. Unprefixed / short ids fall
 * back to a plain head slice.
 */
const KNOWN_PREFIXES = ['standalone_mach_', 'daemon_mach_', 'mach_'] as const;

/** Number of discriminating characters kept in the abbreviation. */
const KEEP = 8;

export function maskDaemonId(id: string | undefined | null): string {
    if (!id) return '(empty)';
    for (const prefix of KNOWN_PREFIXES) {
        if (id.startsWith(prefix)) {
            const rest = id.slice(prefix.length);
            // Keep the prefix visible (it identifies the id *class*, which matters when
            // debugging canonical-identity mismatches) but abbreviate the unique part.
            return rest.length <= KEEP ? `${prefix}${rest}` : `${prefix}${rest.slice(0, KEEP)}…`;
        }
    }
    return id.length <= KEEP ? id : `${id.slice(0, KEEP)}…`;
}
