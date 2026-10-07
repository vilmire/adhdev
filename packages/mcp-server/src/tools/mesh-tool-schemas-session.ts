/**
 * MCP tool schemas — session and node domain (mesh-tools-session.ts /
 * mesh-tools-git.ts handlers): send a task, read chat / debug / terminal, send keys,
 * launch a session, git status, node logs, fast-forward, daemon restart, checkpoint.
 * Pure data; ALL_MESH_TOOLS in mesh-tool-schemas.ts is the registry.
 */
import { MESH_TASK_INPUT_SCHEMA } from './mesh-tool-input-schemas.js';
import { enumOf, MESH_TASK_MODES, MESH_TASK_DIFFICULTIES, MESH_DELIVERY_MODES } from '@adhdev/mesh-shared';

export const MESH_SEND_TASK_TOOL = {
    name: 'mesh_send_task',
    description: 'Push a task straight to a specific node/session, bypassing the queue — an idle target runs it immediately. Use for a same-session continuation or handoff, or to force a node; otherwise prefer mesh_enqueue_task. A direct dispatch is never redelivered automatically after a failure.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (from mesh_list_nodes).' },
            session_id: { type: 'string', description: 'Optional. Omitted: a remote node picks its own session for this workspace; a local node routes it via the queue pull.' },
            message: { type: 'string', description: 'Natural-language task to send to the agent.' },
            input: MESH_TASK_INPUT_SCHEMA,
            task_mode: { ...enumOf(MESH_TASK_MODES), description: 'Optional. live_debug_readonly rejects obvious write/commit/push/deploy/destructive instructions before dispatch.' },
            readonly: { type: 'boolean', description: 'Read-only axis (any task_mode): no write isolation, read-only cap, rejects write instructions.' },
            owned_paths: { type: 'array', items: { type: 'string' }, description: 'As mesh_enqueue_task: repo-relative files/dirs (trailing /** = subtree) this code_change task touches; opt-in, not routing — feeds the overlap check and the touched_files comparison.' },
            mission_id: { type: 'string', description: 'Full/exact mission id (attributes the task and its completion); unresolvable → REJECTED (mission_not_found).' },
            difficulty: { ...enumOf(MESH_TASK_DIFFICULTIES), description: 'REQUIRED. Does not route here; recorded for analytics, mission aggregates and recovery relaunch (inherited from the ledger).' },
            delivery_mode: {
                ...enumOf(MESH_DELIVERY_MODES),
                description: "Busy target only. Default 'when_idle': delivered once idle, turn undisturbed. "
                    + "'interrupt' ABORTS the turn (provider stop control: Ctrl-C, ESC on antigravity-cli) then delivers — work in progress, partial edits included, is DISCARDED; only when finishing the turn is worse than losing it. "
                    + 'No stop control → REJECTED, never silently downgraded.',
            },
            allow_stale_node: { type: 'boolean', description: "Default false. Non-readonly dispatch to a dirty tree or one behind upstream beyond autoFastForward.maxBehind is refused (dirty_workspace / node_stale_behind_upstream, the claim-gate predicates); true when the task IS fixing that tree." },
            allow_quota_exhausted: { type: 'boolean', description: "Default false. A dispatch naming session_id is refused when that provider is measurably quota-exhausted (queue-claim predicate; stale/missing data fails OPEN); true e.g. to test its quota error. Sessionless dispatch: the claim gate applies instead." },
        },
        // session_id is deliberately NOT required: meshSendTask supports a sessionless
        // dispatch (node-scoped on the worker) and the required-arg gate enforces this list.
        required: ['node_id', 'message', 'difficulty'],
    },
};

export const MESH_READ_CHAT_TOOL = {
    name: 'mesh_read_chat',
    description: 'Read recent chat messages from a delegated agent session on a mesh node. Use compact=true for coordinator context-efficient review: it filters tool/internal/debug chatter and returns the final user-visible summary plus recent key messages. If the runtime session has completed, provider_session_id can explicitly target provider transcript history.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to read from.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed sessions.' },
            tail: { type: 'number', description: 'Number of recent messages to return (default: 10).' },
            compact: { type: 'boolean', description: 'When true, return a compact coordinator summary instead of the full transcript: tool/internal/control/debug messages are excluded and only recent user-visible key messages plus the final assistant summary are included.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_READ_DEBUG_TOOL = {
    name: 'mesh_read_debug',
    description: 'Collect a daemon-side chat/parser debug bundle for a delegated agent session on a mesh node without opening the browser UI. Defaults to daemon_file delivery and returns a saved bundle locator.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID to debug.' },
            provider_session_id: { type: 'string', description: 'Optional provider transcript/session ID for completed session history.' },
            tail: { type: 'number', description: 'Number of recent read_chat messages to embed (default: 40).' },
            delivery: { type: 'string', enum: ['daemon_file', 'inline'], description: 'daemon_file saves the full sanitized bundle on the daemon; inline returns it directly. Default: daemon_file.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_READ_TERMINAL_TOOL = {
    name: 'mesh_read_terminal',
    description: 'Read the CURRENT raw terminal screen (the rendered PTY viewport — what a human would see on screen right now) of a delegated agent session on a mesh node. '
        + 'This is the LIVE screen, not the parsed chat transcript: use it to see exactly what the worker is showing — a prompt it is parked on, a modal, a spinner, or unparsed output that mesh_read_chat does not surface. For the conversation transcript use mesh_read_chat instead. '
        + 'The reply is byte-bounded (default 32KiB, max 64KiB; the BOTTOM of the screen — prompt/modal/recent output — is kept when truncated) and returns truncated/original_bytes/returned_bytes plus the cursor position and viewport size. '
        + 'Scoped to coordinator-spawned mesh worker sessions only. NOTE: the raw screen can contain tokens / command args / env values, so treat the returned text as sensitive.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID whose live terminal viewport to read.' },
            max_bytes: { type: 'number', description: 'Optional UTF-8 byte cap for the returned screen text (default 32768, clamped to [1024, 65536]). When the screen exceeds it, the bottom (most recent) lines are kept.' },
        },
        required: ['node_id', 'session_id'],
    },
};

export const MESH_SEND_KEYS_TOOL = {
    name: 'mesh_send_keys',
    description: 'Inject a STRUCTURED key sequence into a delegated worker session\'s live PTY (keystrokes a human would type). '
        + 'Use for interactions mesh_send_task cannot express: dismiss/answer a non-approval prompt, navigate a picker (arrows/TAB), submit an already-typed line (ENTER), correct input (BACKSPACE), or interrupt a runaway command (CTRL_C). For sending a task/message, use mesh_send_task; for an APPROVAL modal, use mesh_approve (send_keys is refused on an actionable approval modal by design). '
        + 'Each sequence item is either {"text":"literal"} or {"key":NAME} where NAME ∈ ENTER|ESC|CTRL_C|UP|DOWN|LEFT|RIGHT|TAB|BACKSPACE. text+ENTER is submitted atomically. '
        + 'DESTRUCTIVE keys (CTRL_C, ESC) can kill/derail the worker and require BOTH confirm_destructive=true AND mesh policy allowSendKeysDestructive — otherwise refused. '
        + 'The injection is refused if the session has a pending submit/echo race, or (for non-destructive keys) an actionable approval modal. Scoped to coordinator-spawned mesh worker sessions. Each injection is audited (key enums + result; the literal text body is NOT recorded).',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            session_id: { type: 'string', description: 'Agent session ID whose PTY to inject into.' },
            sequence: {
                type: 'array',
                description: 'Ordered key sequence. Each item is {"text":"literal UTF-8"} OR {"key":"ENTER|ESC|CTRL_C|UP|DOWN|LEFT|RIGHT|TAB|BACKSPACE"}. Max 64 items, 4096 total text bytes.',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'Literal UTF-8 text to type.' },
                        key: { type: 'string', enum: ['ENTER', 'ESC', 'CTRL_C', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'TAB', 'BACKSPACE'], description: 'Named key.' },
                    },
                },
            },
            confirm_destructive: { type: 'boolean', description: 'Required true when the sequence contains a destructive key (CTRL_C/ESC). Also requires mesh policy allowSendKeysDestructive.' },
            allow_modal_override: { type: 'boolean', description: 'Override the actionable-approval-modal fail-closed refusal for NON-destructive keys. Use only when you deliberately need to inject into a modal-parked session that is NOT an approval you should route through mesh_approve.' },
        },
        required: ['node_id', 'session_id', 'sequence'],
    },
};

export const MESH_LAUNCH_SESSION_TOOL = {
    name: 'mesh_launch_session',
    description: 'Launch a new agent session on a mesh node. Returns the session ID for subsequent send_task/read_chat calls. If the user names a provider, preserve it exactly: Claude Code/Claude = claude-cli, Codex = codex-cli, Cursor = cursor-cli, Kimi = kimi, OpenCode = opencode, Grok = grok-cli, Antigravity = antigravity-cli. If type is omitted, resolve strictly from the node policy providerPriority and provider detection; fail closed when no configured provider is usable. Do not default to claude-cli.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            type: { type: 'string', description: 'Optional provider type to launch. Use claude-cli for Claude Code, codex-cli for Codex, cursor-cli for Cursor, kimi for Kimi, opencode for OpenCode, grok-cli for Grok, antigravity-cli for Antigravity. When omitted, node.policy.providerPriority is probed in order.' },
            force: { type: 'boolean', description: 'Set true to launch an ADDITIONAL session even when this node already has a live mesh-owned worker session. Default false: if a live worker session for this mesh+node already exists (e.g. an enqueue auto-launch just spawned one), the existing session is returned idempotently instead of creating an empty duplicate. Only pass force when you intentionally want a second concurrent provider/session on the node.' },
        },
        required: ['node_id'],
    },
};

export const MESH_GIT_STATUS_TOOL = {
    name: 'mesh_git_status',
    description: 'Get git status for a mesh node workspace — branch, dirty state, changed files.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
        },
        required: ['node_id'],
    },
};

export const MESH_READ_NODE_LOGS_TOOL = {
    name: 'mesh_read_node_logs',
    description: 'Fetch a recent daemon LOG tail directly from a (possibly remote) mesh node over P2P — no session launch, no PowerShell/shell grep on the remote machine. '
        + 'Use this to debug a node\'s daemon: read its error/warn lines, grep for a pattern, or read since a timestamp. '
        + 'The reply is byte-bounded (≤128KB, default 64KB; truncated:true when the file was larger, newest lines kept) and secrets (API keys, machine secrets, bearer tokens, JWTs, TURN credentials) are redacted before transmission. '
        + 'This reads the DAEMON log, not an agent session transcript — for a session transcript use mesh_read_chat / mesh_read_debug.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID (the daemon owning it serves its own log).' },
            grep: { type: 'string', description: 'Optional regex (case-insensitive) — only matching log lines are returned. Invalid regex falls back to a literal substring match.' },
            since_ms: { type: 'number', description: 'Optional epoch-ms floor — only log lines at/after this time are returned (lines without a parseable timestamp are kept).' },
            tail_bytes: { type: 'number', description: 'Max bytes of log tail to read (default 65536, capped at 131072). Larger files are truncated to the newest tail_bytes.' },
            date: { type: 'string', description: 'Optional YYYY-MM-DD log date (defaults to today). Falls back to the size-rotation backup when the active file is absent.' },
        },
        required: ['node_id'],
    },
};

export const MESH_FAST_FORWARD_NODE_TOOL = {
    name: 'mesh_fast_forward_node',
    description: 'Safely dry-run or execute an obvious direct fast-forward for a mesh node without launching an agent session. '
        + 'mode="merge" (default) absorbs upstream commits into the local branch via git merge --ff-only (ahead=0, behind>0). '
        + 'mode="push" publishes local commits to origin via a strict ff-only push (HEAD must be a descendant of origin/<branch>). '
        + 'Defaults to dry-run; execution requires execute=true. Never force-pushes, rebases, resets, cleans, or checks out arbitrary revisions. '
        + 'When the merge path finds the branch ahead with nothing to merge, it returns code "ahead_needs_push" pointing at mode="push".',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            mode: { type: 'string', enum: ['merge', 'push'], description: 'merge (default): git merge --ff-only to absorb upstream. push: strict ff-only push of local commits to origin/<branch>; refuses any non-fast-forward.' },
            branch: { type: 'string', description: 'Optional guard: require the node\'s current branch to match this branch before planning/executing.' },
            execute: { type: 'boolean', description: 'When true, apply the fast-forward/push if all safety gates pass. Defaults false/dry-run.' },
            dry_run: { type: 'boolean', description: 'Preview only. Defaults true unless execute=true; dry_run=true overrides execute. dry_run=false is NOT an execute trigger — it only declines to veto, so passing it alone is rejected with dry_run_false_requires_execute rather than silently previewing. Use execute=true to apply.' },
            update_submodules: { type: 'boolean', description: 'mode="merge" only: when true, if the root fast-forward changes gitlinks, run only git submodule update --init --recursive and verify submodules clean.' },
            push_submodules: { type: 'boolean', description: 'mode="push" only: also ff-only push submodule HEADs to their origin main. Gated by mesh policy allowAutoPublishSubmoduleMainCommits — skipped unless that policy is enabled. Defaults false (root push only).' },
        },
        required: ['node_id'],
    },
};

export const MESH_RESTART_DAEMON_TOOL = {
    name: 'mesh_restart_daemon',
    description: 'Restart (default: update, then restart) a node\'s daemon — the dashboard "preview update" path; no agent session. '
        + 'Idle-gated: an active session (generating / waiting_approval / starting) refuses it with "blocking_sessions" (see self_only / when_idle / force). '
        + 'Windows: any restart/upgrade ends all hosted sessions; POSIX: they survive a plain restart and rebind. '
        + 'daemonMismatch/trackMismatch/trackWarning flag (without blocking) that meshAttachedDaemon (answered status) differs from restartTargetDaemon (took the operation); null = old/unreachable daemon.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Node whose owning daemon is restarted.' },
            channel: { type: 'string', enum: ['stable', 'preview'], description: 'DEPRECATED, ignored (an upgrade targets the daemon\'s own build track); a conflict is echoed as channelOverride.' },
            allow_downgrade: { type: 'boolean', description: 'Upgrade: allow an OLDER target, for a deliberate rollback (default false → "downgrade_refused").' },
            mode: { type: 'string', enum: ['upgrade', 'restart'], description: 'upgrade (default): latest on the daemon\'s build track, then restart; already latest = no-op (alreadyLatest:true). restart: re-spawn only, shorter downtime — resets wedged state (leaks, zombie sessions).' },
            force: { type: 'boolean', description: 'Bypass the idle-gate. Destructive: kills in-flight turns, loses the in-memory pendingOutboundQueue.' },
            self_only: { type: 'boolean', description: 'Waive only this mesh\'s own coordinator session (always generating while it calls); others still block.' },
            when_idle: { type: 'boolean', description: 'If blocked, run once the daemon is idle (safest, no queue loss); shown as deferredRestart, expires after timeout_ms.' },
            cancel_when_idle: { type: 'boolean', description: 'Cancel a scheduled when_idle restart on the owning daemon.' },
            timeout_ms: { type: 'number', description: 'when_idle expiry in ms (default 1800000 = 30 min, max 6 h).' },
            kill_session_host: { type: 'boolean', description: 'Hard refresh: also stop the session-host, ending ALL hosted CLI sessions on the machine (as Windows always does).' },
        },
        required: ['node_id'],
    },
};

export const MESH_CHECKPOINT_TOOL = {
    name: 'mesh_checkpoint',
    description: 'Create a git checkpoint (commit) on a mesh node workspace.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            node_id: { type: 'string', description: 'Target node ID.' },
            message: { type: 'string', description: 'Checkpoint commit message.' },
        },
        required: ['node_id', 'message'],
    },
};
