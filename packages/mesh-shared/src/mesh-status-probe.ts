/**
 * OFFLINE-NODE-STATUS-REFRESH — the status-origin probe marker.
 *
 * A remote `git_status` (or any relayed/dispatched mesh command) that originates from
 * an explicit_refresh / mesh_status aggregate carries this marker inside its ARGS. The
 * daemon-cloud dispatch wrapper and MCP relay handler read it to grant the SHORT
 * connect-wait budget so a single offline (powered-off) peer no longer blocks the whole
 * status assembly for ~90s.
 *
 * It is deliberately an args marker rather than adding `git_status` to the global
 * probe-class command set: a user-driven / targeted `git_status` (no marker) must keep
 * waiting out the full connect deadline for a slow relay to open (rc.503 intent). Only a
 * status-origin probe opts into the short budget.
 *
 * The key is `_`-prefixed so it travels alongside the real args (workspace,
 * refreshUpstream, includeSubmodules, …) and is ignored by the git_status handler; the
 * dispatch/relay sites strip it defensively before the command executes so it never
 * reaches a handler that echoes unknown args.
 *
 * This dependency-free leaf is the single source of truth shared by daemon-core (the
 * aggregate probe producer), mcp-server (the MCP relay producer), and daemon-cloud (the
 * dispatch/relay consumer) so the key cannot drift between producer and consumer.
 */
export const STATUS_PROBE_ARG_KEY = '_statusProbe' as const;

/** Stamp the status-origin probe marker onto a command's args (non-mutating). */
export function withStatusProbeMarker(
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...args, [STATUS_PROBE_ARG_KEY]: true };
}

/** True when the args carry the status-origin probe marker. */
export function argsCarryStatusProbeMarker(args: unknown): boolean {
  return (
    !!args &&
    typeof args === 'object' &&
    (args as Record<string, unknown>)[STATUS_PROBE_ARG_KEY] === true
  );
}

/**
 * Return a shallow copy of args with the internal marker removed so it never leaks to
 * the executing command handler. Returns the original reference when no marker is
 * present (avoids an allocation on the common path).
 */
export function stripStatusProbeMarker(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!argsCarryStatusProbeMarker(args)) return args;
  const { [STATUS_PROBE_ARG_KEY]: _drop, ...rest } = args;
  return rest;
}
