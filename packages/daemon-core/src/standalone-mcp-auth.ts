/**
 * Standalone daemon ↔ daemon-launched MCP server authentication contract.
 *
 * A standalone daemon started with `--token` (or with a dashboard password)
 * answers 401 to every `/api/*` request that carries no dashboard credential.
 * The MCP servers the daemon itself launches for the agents it runs — the
 * mesh coordinator (`--repo-mesh`), the assistant (`--assistant`) and every
 * delegated worker (`--worker`) — talk to it over that same HTTP API
 * (LocalTransport), so on a gated daemon they could not even ping it and
 * exited at startup ("Cannot reach local daemon", task_failed session_exit).
 *
 * The dashboard token / password must NOT be written into the generated MCP
 * configs (they outlive the launch, some live in the workspace, and a worker
 * holding it would hold full dashboard power; password mode only keeps a hash
 * anyway). Instead there are two narrower, loopback-only credentials:
 *
 * - WORKER scope — the worker's own session bind (`ADHDEV_WORKER_SESSION_BIND`,
 *   or the legacy per-task token), sent in `ADHDEV_WORKER_CREDENTIAL_HEADER`.
 *   The daemon already verifies that bind for every worker verb, its SHA-256
 *   is persisted in mesh-runtime.db, and a restored worker's bind is re-adopted
 *   after a daemon restart — so no new secret exists and nothing breaks when
 *   the daemon restarts under a live worker. It admits only the verbs the
 *   worker toolset sends (`WORKER_MCP_DAEMON_VERBS`) plus a liveness-only
 *   status probe.
 *
 * - COORDINATOR scope — a random token minted per daemon boot, held in memory
 *   and written to a 0600 file under the daemon's config dir. The coordinator /
 *   assistant MCP launch carries the file's PATH (`--daemon-auth-file`), never
 *   the token, and the MCP re-reads the file on every request, so a launch
 *   config written before a restart keeps working after it (the new boot
 *   rewrites the file). It admits `GET /api/v1/status` and
 *   `POST /api/v1/command` — the whole surface those toolsets use, and nothing
 *   else (no password/preferences/raw-terminal routes).
 *
 * Both are accepted only from a loopback peer. Like the bind itself, these are
 * least-privilege plumbing between processes of one OS user, not a defence
 * against that user: a same-user process can read the token file regardless.
 */
// Leaf module (no imports): the launch builder (commands/mesh-coordinator.ts)
// and mcp-server read these constants. The credential CHECK lives in
// standalone-mcp-auth-verify.ts so this file stays dependency-free.

/** Request header carrying the per-boot coordinator-scope token. */
export const ADHDEV_INTERNAL_AUTH_HEADER = 'x-adhdev-internal-auth';
/** Request header carrying a worker's session bind (or per-task token). */
export const ADHDEV_WORKER_CREDENTIAL_HEADER = 'x-adhdev-worker-credential';
/** mcp-server: path of the coordinator-scope token file (env twin of `--daemon-auth-file`). */
export const ADHDEV_DAEMON_AUTH_FILE_ENV = 'ADHDEV_DAEMON_AUTH_FILE';
/** mcp-server CLI flag naming the coordinator-scope token file. */
export const ADHDEV_DAEMON_AUTH_FILE_FLAG = '--daemon-auth-file';
/**
 * Daemon process env: the token file a coordinator / assistant MCP launch
 * should name. Set by the standalone daemon next to
 * `ADHDEV_COORDINATOR_MCP_PORT` — the same channel that tells the launch where
 * the daemon listens. Never read by worker launches.
 */
export const ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV = 'ADHDEV_COORDINATOR_MCP_AUTH_FILE';

/**
 * Every daemon command the `--worker` MCP toolset sends (mcp-server
 * worker-tools.ts, worker-report-outbox.ts and the read-only git tools). The
 * worker-scope gate admits these and nothing else; an mcp-server test keeps
 * the list in step with the toolset's sources.
 */
export const WORKER_MCP_DAEMON_VERBS: readonly string[] = Object.freeze([
    'worker_report_completion',
    'worker_progress_update',
    'worker_peer_context_pull',
    'worker_drain_mailbox',
    'git_status',
    'git_diff_summary',
    'git_diff_file',
    'git_log',
]);

const WORKER_VERB_SET = new Set(WORKER_MCP_DAEMON_VERBS);

export function isWorkerMcpDaemonVerb(type: unknown): boolean {
    return typeof type === 'string' && WORKER_VERB_SET.has(type);
}
