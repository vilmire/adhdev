/**
 * Command → dashboard-subscription invalidation table — SINGLE SOURCE OF TRUTH.
 *
 * "Which daemon command invalidates which dashboard subscription topics
 * (forcing an immediate flush instead of waiting for the ~30s heartbeat)"
 * used to be maintained as three separately hardcoded lists — two in
 * daemon-cloud (`adhdev-daemon.ts` handleCommand / handleP2PCommand) and one
 * in daemon-standalone (`index.ts` executeCommand) — which had already
 * diverged (standalone reacted to mesh-graph commands and
 * set_user_name/set_machine_nickname; cloud did not). This module is the one
 * place that knowledge lives now. Each daemon keeps its own transport-specific
 * flush MECHANISM (P2P DataChannel vs local WebSocket); only the
 * command→topics table is shared.
 *
 * The table's content is the UNION of the pre-unification behaviors, so every
 * consumer flushes at least as eagerly as the most eager daemon did.
 *
 * Incident context for individual entries (kept from the original call sites):
 * - DASHBOARD-GHOST-LINGER: cleanup_mesh_sessions deletes sessions; without an
 *   immediate daemon.metadata flush the deleted rows linger as ghost sessions
 *   until the next heartbeat.
 * - HIDDEN-MUTE-STICK: set_conversation_prefs persists userHidden/userMuted
 *   which surface as surfaceHidden/muted in the daemon.metadata snapshot;
 *   without a flush the toggle visually reverts after the web-core 8s
 *   optimistic overlay expires.
 */

import type { TransportTopic } from '../shared-types.js';

/** Subset of transport topics that command execution can invalidate. */
export type CommandInvalidationTopic = Extract<
    TransportTopic,
    'daemon.metadata' | 'session_host.diagnostics' | 'session.modal' | 'workspace.git'
>;

/**
 * Commands that may change the mesh graph / node-session topology the
 * dashboard renders (moved verbatim from daemon-standalone/src/index.ts, which
 * was the only daemon that had this — cloud gains it via the union).
 */
export function commandMayAffectMeshGraphStatus(command: string): boolean {
    return command.startsWith('mesh_')
        || command === 'add_mesh_node'
        || command === 'update_mesh_node'
        || command === 'remove_mesh_node'
        || command === 'clone_mesh_node'
        || command === 'trigger_mesh_queue'
        || command === 'get_mesh_queue'
        || command === 'launch_cli'
        || command === 'stop_cli'
        || command === 'restart_session';
}

/** Exact-name commands that invalidate the daemon.metadata snapshot. */
const DAEMON_METADATA_COMMANDS: ReadonlySet<string> = new Set([
    'get_status_metadata',
    'cleanup_mesh_sessions',   // DASHBOARD-GHOST-LINGER
    'set_conversation_prefs',  // HIDDEN-MUTE-STICK
    'invoke_provider_script',
    'set_user_name',
    'set_machine_nickname',
]);

/** Exact-name commands that invalidate the session.modal snapshot. */
const SESSION_MODAL_COMMANDS: ReadonlySet<string> = new Set([
    'resolve_action',
    'send_chat',
    'read_chat',
]);

const EMPTY_TOPICS: ReadonlySet<CommandInvalidationTopic> = new Set();

/**
 * Returns the set of dashboard subscription topics an executed command
 * invalidates. Callers should force-flush each returned topic through their
 * own transport immediately after the command completes.
 */
export function commandInvalidations(command: string): ReadonlySet<CommandInvalidationTopic> {
    if (typeof command !== 'string' || !command) return EMPTY_TOPICS;
    const topics = new Set<CommandInvalidationTopic>();
    if (
        DAEMON_METADATA_COMMANDS.has(command)
        || command.startsWith('workspace_')
        || command.startsWith('session_host_')
        || commandMayAffectMeshGraphStatus(command)
    ) {
        topics.add('daemon.metadata');
    }
    if (command.startsWith('session_host_')) topics.add('session_host.diagnostics');
    if (SESSION_MODAL_COMMANDS.has(command)) topics.add('session.modal');
    if (command.startsWith('git_')) topics.add('workspace.git');
    return topics.size > 0 ? topics : EMPTY_TOPICS;
}
