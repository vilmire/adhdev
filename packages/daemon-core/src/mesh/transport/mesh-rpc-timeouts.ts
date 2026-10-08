// ---------------------------------------------------------------------------
// mesh-rpc-timeouts — per-command result deadlines for the daemon↔daemon mesh RPC
// ---------------------------------------------------------------------------
// Leaf module (mesh-shared only) so the pure command→deadline classification can
// be unit tested without constructing a transport. Lives in daemon-core since the
// standalone WebSocket transport shares these budgets with the cloud WebRTC one.
//
// This is the RELAY (layer-2) budget. The full timeout chain is, per heavy verb:
//   IPC (layer-1, mcp-server transports/ipc.ts) >= relay (here) >= responder budget.
// For a REMOTE node the coordinator wraps the verb in `mesh_relay_command` (IPC 120s),
// so IPC already dominates every relay value here. For a LOCAL node there is no relay
// layer — the IPC table's bare-verb entry must directly cover the responder budget.
// ---------------------------------------------------------------------------

/** Read an env-overridable timeout, clamped to [1s, 120s]; else the fallback. */
export function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000) return parsed;
  }
  return fallback;
}

// Default result deadline for commands without a specific classification. This is
// the historical single value; it is now only the FALLBACK — most commands pick a
// per-command value below.
export const REQUEST_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_REQUEST_TIMEOUT_MS', 30_000);

// Per-command result deadlines. The old transport used one 30s value for every
// command — too short for a cross-machine git op behind TURN (the observed
// `fast_forward_mesh_node` false-timeout: the remote applied the ff and replied,
// but the round trip just edged past 30s), and needlessly long for a cheap probe.
// Classification is by command name; anything unmatched uses REQUEST_TIMEOUT_MS.
export const GIT_COMMAND_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_GIT_TIMEOUT_MS', 90_000);
export const PROBE_COMMAND_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_PROBE_TIMEOUT_MS', 15_000);
// Sender-side deadline for a remote `git_status` probe. This MUST NOT be smaller
// than the responder's own git-status budget (daemon-core GIT_STATUS_TIMEOUT_MS:
// win32 30s / posix 20s) or the sender rejects and discards a slow-but-successful
// reply before it lands — the exact timeout mismatch that wedged the Windows mesh
// graph (responder finished at ~30s, sender's 15s probe deadline already fired).
// Set to 30s so it covers the responder's worst case. With the `git submodule
// status` shell wrapper removed (status now collects in seconds, not 50s) this
// ceiling is almost never reached, but keeping it ≥ the responder budget closes
// the mismatch defensively. Env-overridable for very slow relayed peers.
export const GIT_STATUS_PROBE_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_GIT_STATUS_PROBE_TIMEOUT_MS', 30_000);
// Repo-mutating worktree teardown: `remove_mesh_node` synchronously runs session
// cleanup plus `git worktree remove` (responder git budget 30s) and can edge past
// the 30s REQUEST_TIMEOUT default on a slow host. Lighter than a full clone/refine,
// so it gets its own 60s tier rather than the 90s git budget.
export const REPO_MUTATION_COMMAND_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_REPO_MUTATION_TIMEOUT_MS', 60_000);

// Handshake-aware per-request budget for a probe-class command whose target peer is
// actively connecting. The old 2s value raced real post-idle/restart handshakes that
// opened at 2.0–2.4s, rejecting the request just before the shared peer became usable.
// 12s covers that observed cold open plus the bounded TURN application-data probe
// (8s) and jitter, while remaining far below the manager's documented 90s general
// connection cap. The timer still rejects only THIS queued probe; it never creates a
// second PeerConnection or tears down the shared background attempt.
// Lives in this dependency-free leaf (not the native-backed manager) so the dispatch
// site can import it without pulling node-datachannel at module load. Re-exported from
// daemon-mesh-manager for the historical import surface.
export const PROBE_CONNECT_WAIT_MS = readTimeoutEnv('MESH_RPC_PROBE_CONNECT_WAIT_MS', 12_000);

// Heavy, repo-mutating or repo-walking commands that can legitimately take tens of
// seconds across a relayed link.
//
// `clone_mesh_node` belongs here: its responder synchronously runs `createWorktree`
// (daemon-core git-worktree GIT_TIMEOUT_MS 30s) and then a bounded setup-wait
// (Promise.race capped at ~14s) before replying — a ~44s worst-case synchronous
// round trip that overran the 30s REQUEST_TIMEOUT default and false-timed-out the
// sender while the responder was still creating the worktree. 90s gives headroom;
// the submodule init (120s) continues in the background after the reply.
//
// A6 note: `refine_mesh_node` / `mesh_refine_node` keep the 90s budget even though
// the responder's internal REFINE_VALIDATION_TIMEOUT_MS is 120s (> 90s). That is
// NOT a sender-too-short mismatch: refine is async-job-ack — the responder returns
// { async:true, status:'accepted' } immediately and runs validation in the
// background — so this 90s deadline only ever bounds the instant ack round trip,
// never the 120s validation. Do not "fix" it by raising to ≥120s; the synchronous
// reply is sub-second. (See plan_mesh_refine_node, the synchronous dry-run path,
// for the case that actually needs a longer budget.)
const GIT_COMMANDS = new Set<string>([
  'fast_forward_mesh_node',
  'refine_mesh_node',
  'mesh_fast_forward_node',
  'mesh_refine_node',
  'clone_mesh_node',
]);
const REPO_MUTATION_COMMANDS = new Set<string>([
  'remove_mesh_node',
]);
// Remote git-status probes: cheap on a healthy repo, but the responder's git budget
// can stretch to 30s on a slow (Windows) host, so they get their own deadline that
// stays aligned with that budget rather than the short cheap-poll deadline below.
const GIT_STATUS_PROBE_COMMANDS = new Set<string>([
  'git_status',
  'mesh_git_status',
  'plan_mesh_onboarding',
]);
// The host side of a remote-hosted assistant project (daemon-core
// commands/high-family/assistant-remote.ts). Its `send` op may launch the mesh's
// coordinator on the host before it answers (tens of seconds), so the default 30s
// would reject a send the host is still completing. The caller bounds each op
// itself (assistant/assistant-remote-host.ts REMOTE_OP_TIMEOUT_MS: poll 15s, send
// 90s), so this is only the transport's ceiling.
export const ASSISTANT_RELAY_COMMAND_TIMEOUT_MS = readTimeoutEnv('MESH_RPC_ASSISTANT_RELAY_TIMEOUT_MS', 90_000);
const ASSISTANT_RELAY_COMMANDS = new Set<string>([
  'assistant_remote_project',
]);
// Cheap, frequent status/poll commands whose round trip should be quick — a long
// deadline here just delays detecting a truly wedged peer.
const PROBE_COMMANDS = new Set<string>([
  'get_pending_mesh_events',
]);

/** Select the result deadline for a command. Pure — unit tested. */
export function resultTimeoutForCommand(command: string): number {
  if (GIT_COMMANDS.has(command)) return GIT_COMMAND_TIMEOUT_MS;
  if (REPO_MUTATION_COMMANDS.has(command)) return REPO_MUTATION_COMMAND_TIMEOUT_MS;
  if (GIT_STATUS_PROBE_COMMANDS.has(command)) return GIT_STATUS_PROBE_TIMEOUT_MS;
  if (PROBE_COMMANDS.has(command)) return PROBE_COMMAND_TIMEOUT_MS;
  if (ASSISTANT_RELAY_COMMANDS.has(command)) return ASSISTANT_RELAY_COMMAND_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}

// OFFLINE-NODE-FANOUT: read-only fan-out probes issued by the reconcile / completion
// loops against EVERY mesh node each tick. These are the calls that must NOT inherit
// the 90s connect wait when one node is offline (powered off) — they should give up in
// ~seconds against an unconnected peer and be retried next tick (lossless: an
// unconnected peer drained nothing). A targeted, mutation/connect-intent command
// (clone / refine / fast_forward / remove / a user-driven git_status) is deliberately
// EXCLUDED so it keeps waiting out the full connect deadline for a slow relay to open.
const PROBE_CLASS_COMMANDS = new Set<string>([
  'get_pending_mesh_events',
  'get_status_metadata',
  'read_chat',
]);

/** True for a read-only fan-out probe that should use the SHORT connect-wait budget
 *  (so an offline node does not block coordinator fan-out). Pure — unit tested. */
export function isProbeClassMeshCommand(command: string): boolean {
  return PROBE_CLASS_COMMANDS.has(command);
}

// OFFLINE-NODE-STATUS-REFRESH: the status-origin probe marker + its pure helpers live in
// the dependency-free @adhdev/mesh-shared leaf so the daemon-core aggregate producer, the
// mcp-server MCP relay producer, and this daemon-cloud consumer all reference ONE key and
// cannot drift. Re-exported here for the historical import surface (existing callers +
// tests import these from mesh-rpc-timeouts).
import { argsCarryStatusProbeMarker } from '@adhdev/mesh-shared';
export {
  STATUS_PROBE_ARG_KEY,
  argsCarryStatusProbeMarker,
  stripStatusProbeMarker,
} from '@adhdev/mesh-shared';

/**
 * Resolve the per-request connect-wait budget for a dispatched/relayed mesh command.
 * Returns the SHORT PROBE_CONNECT_WAIT_MS budget when the command is inherently
 * probe-class OR when the args carry the status-origin marker (an explicit_refresh /
 * mesh_status git_status probe); otherwise undefined (legacy full connect wait).
 * Pure — unit tested. Centralizes the rule so the daemon-core dispatch wrapper
 * (adhdev-daemon.ts) and the MCP relay handler (adhdev-daemon-local-ipc.ts) stay
 * consistent. Unlike adding git_status to PROBE_CLASS_COMMANDS globally, the marker
 * scopes the short connect-wait to STATUS-origin probes only — a user-driven / targeted
 * `git_status` (no marker) keeps waiting out the full connect deadline for a slow relay
 * to open, per rc.503 intent.
 */
export function resolveMeshConnectWaitMs(command: string, args?: unknown): number | undefined {
  if (isProbeClassMeshCommand(command) || argsCarryStatusProbeMarker(args)) {
    return PROBE_CONNECT_WAIT_MS;
  }
  return undefined;
}
