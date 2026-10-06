/**
 * Standalone multi-machine mesh endpoints (design
 * docs/design/2026-10-07-standalone-multi-machine-mesh.md §4.3–§4.4) — the single
 * source for the host's mesh paths and for turning an operator-typed host address
 * into a URL.
 *
 * Dependency-free on purpose: it is imported by mesh/transport (WS dial),
 * commands/med-family (HTTP join), seqscribe (replication lane path) and the
 * standalone server. `seqscribe/**` may not value-import `mesh/**`
 * (check:boundaries), so this lives in shared/.
 */

/** Host WebSocket path for daemon↔daemon mesh RPC (handshake first). */
export const MESH_RPC_WS_PATH = '/ws/mesh';
/** Host WebSocket path for daemon↔daemon seqscribe replication (handshake first). */
export const MESH_SEQSCRIBE_WS_PATH = '/ws/mesh-seqscribe';
/** Standalone host endpoint a member POSTs its join request to (the pairing token is the credential). */
export const MESH_JOIN_HTTP_PATH = '/api/v1/mesh/join';

export interface MeshHostAuthority {
    /** True for https:// / wss:// addresses. */
    secure: boolean;
    /** `host[:port]`, IPv6 literals bracketed. */
    authority: string;
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Parse what an operator types or the pairing flow stores as a host address:
 * `ip:port`, `hostname:port`, `[v6]:port`, a bare IPv6 literal, or an
 * http(s):// / ws(s):// URL with any path, query, fragment or credentials (all
 * dropped). A bare authority may carry a trailing path, which is dropped too.
 *
 * `new URL('192.168.1.5:3847')` throws and `new URL('myhost:3847')` parses
 * `myhost:` as a scheme, so a scheme is only recognised with `://`.
 */
export function parseMeshHostAddress(hostAddress: string): MeshHostAuthority {
    const raw = typeof hostAddress === 'string' ? hostAddress.trim() : '';
    if (!raw) throw new Error('hostAddress required');
    const scheme = SCHEME_RE.exec(raw)?.[1]?.toLowerCase();
    let secure = false;
    let rest = raw;
    if (scheme !== undefined) {
        if (scheme === 'https' || scheme === 'wss') secure = true;
        else if (scheme !== 'http' && scheme !== 'ws') {
            throw new Error(`unsupported mesh host address scheme "${scheme}:"`);
        }
        rest = raw.slice(scheme.length + 3);
    }
    // Authority ends at the first path / query / fragment delimiter.
    let authority = rest.split(/[/?#]/, 1)[0] ?? '';
    // Drop userinfo (never sent anywhere).
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1);
    if (!authority) throw new Error(`invalid mesh host address "${raw}"`);
    // A bare IPv6 literal (two or more colons, no brackets) gets brackets.
    if (!authority.startsWith('[') && (authority.match(/:/g)?.length ?? 0) > 1) authority = `[${authority}]`;
    // Validate through WHATWG URL with an explicit scheme, which also rejects
    // spaces, bad ports and malformed brackets.
    let parsed: URL;
    try {
        parsed = new URL(`http://${authority}/`);
    } catch {
        throw new Error(`invalid mesh host address "${raw}"`);
    }
    if (!parsed.hostname) throw new Error(`invalid mesh host address "${raw}"`);
    // Keep an explicit port even when it is http's default (URL drops `:80`,
    // which would turn `https://h:80` into port 443).
    const explicitPort = /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(authority)?.[1];
    const port = parsed.port || (explicitPort !== undefined ? String(Number(explicitPort)) : '');
    return { secure, authority: port ? `${parsed.hostname}:${port}` : parsed.hostname };
}

function withPath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
}

/** `ws(s)://<authority><path>` for a stored host address (http→ws, https→wss). */
export function meshHostWsUrl(hostAddress: string, path: string): string {
    const { secure, authority } = parseMeshHostAddress(hostAddress);
    return `${secure ? 'wss' : 'ws'}://${authority}${withPath(path)}`;
}

/** `http(s)://<authority><path>` for a stored host address (ws→http, wss→https). */
export function meshHostHttpUrl(hostAddress: string, path: string): string {
    const { secure, authority } = parseMeshHostAddress(hostAddress);
    return `${secure ? 'https' : 'http'}://${authority}${withPath(path)}`;
}

// ─── Host address candidates (shown on the host's pairing card) ───────────────

/** Where the standalone HTTP server (and so the mesh lanes) listens. */
export interface MeshListenAddress {
    /** The bind host the server was started with (`127.0.0.1`, `0.0.0.0`, an IP, …). */
    host: string;
    port: number;
}

/** Structural slice of `os.networkInterfaces()` (keeps this module import-free). */
export type MeshNetworkInterfaces = Record<string, ReadonlyArray<{ address: string; family: string | number; internal: boolean }> | undefined>;

export interface MeshHostAddressCandidates {
    /** `ip:port` strings a member can type, Tailscale (100.64.0.0/10) first, then LAN. */
    addressCandidates: string[];
    /** Set when the server only listens on loopback, so no other machine can reach it. */
    bindWarning?: 'loopback_only';
}

function isLoopbackHost(host: string): boolean {
    const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

function isWildcardHost(host: string): boolean {
    const h = host.trim().replace(/^\[|\]$/g, '');
    return h === '' || h === '0.0.0.0' || h === '::';
}

/** Tailscale's CGNAT range 100.64.0.0/10. */
function isTailscaleIpv4(address: string): boolean {
    const m = /^100\.(\d+)\./.exec(address);
    return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function isIpv4Family(family: string | number): boolean {
    return family === 'IPv4' || family === 4;
}

/**
 * The addresses a member could dial to reach this host. Loopback-only bind →
 * no candidates and `bindWarning: 'loopback_only'` (restart with
 * `--host 0.0.0.0`). Wildcard bind → every non-internal IPv4, Tailscale first.
 * A specific bind address → that address only.
 */
export function computeMeshHostAddressCandidates(
    listen: MeshListenAddress,
    interfaces: MeshNetworkInterfaces,
): MeshHostAddressCandidates {
    const port = Number(listen.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { addressCandidates: [] };
    if (isLoopbackHost(listen.host)) return { addressCandidates: [], bindWarning: 'loopback_only' };
    if (!isWildcardHost(listen.host)) {
        const host = listen.host.trim();
        return { addressCandidates: [host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`] };
    }
    const tailscale: string[] = [];
    const lan: string[] = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.internal || !isIpv4Family(entry.family)) continue;
            const candidate = `${entry.address}:${port}`;
            const bucket = isTailscaleIpv4(entry.address) ? tailscale : lan;
            if (!bucket.includes(candidate)) bucket.push(candidate);
        }
    }
    return { addressCandidates: [...tailscale, ...lan] };
}
