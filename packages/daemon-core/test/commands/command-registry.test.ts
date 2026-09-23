/**
 * Command registry — the migration from nine name tables + four dispatch maps
 * to spec attributes must be lossless.
 *
 * The LEGACY_* constants below are the pre-registry tables copied verbatim
 * (router.ts CHAT_COMMANDS / MESH_FORWARDABLE_SESSION_COMMANDS,
 * command-invalidations.ts, cloud adhdev-daemon.ts MANDATORY_UPDATE_BLOCKED_COMMANDS
 * + shouldFastFlushLaunchStatus, standalone index.ts SESSION_TARGET_COMMANDS,
 * handler.ts sessionScopedCommands / cdpCommands / read-or-debug fallback /
 * dispatch switch, git-commands.ts GIT_COMMAND_NAMES, and the three family
 * registries). Each test derives the same table from the registry and diffs
 * it against the golden, so no command lost or gained a behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
    COMMAND_PREFIX_DEFAULTS,
    CommandRegistry,
    defineCommandSpecs,
    normalizeCommandSource,
    type CommandSpec,
} from '../../src/commands/command-registry.js';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';

// ─── Legacy tables (verbatim) ──────────────────────────────────────────────

const LEGACY_CHAT_COMMANDS = [
    'send_chat', 'new_chat', 'switch_chat', 'set_mode',
    'change_model',
];

const LEGACY_MESH_FORWARDABLE_SESSION_COMMANDS = [
    'invoke_provider_script',
    'resolve_action',
    'cancel_queued_chat',
    'set_mode',
    'change_model',
    'set_thought_level',
    'set_conversation_prefs',
    'agent_command',
    'read_terminal',
    'send_keys',
    'interactive_prompt_response',
];

const LEGACY_MANDATORY_UPDATE_BLOCKED_COMMANDS = [
    'launch_ide',
    'launch_cli',
    'restart_ide',
    'restart_session',
    'session_host_restart_session',
];

const LEGACY_SESSION_TARGET_COMMANDS = [
    'send_chat',
    'cancel_queued_chat',
    'read_chat',
    'expand_tool_block',
    'get_chat_debug_bundle',
    'chat_history',
    'resolve_action',
    'set_cli_view_mode',
    'stop_cli',
    'restart_session',
    'agent_command',
];

const LEGACY_SESSION_SCOPED_COMMANDS = [
    'read_chat',
    'get_chat_debug_bundle',
    'expand_tool_block',
    'send_chat',
    'cancel_queued_chat',
    'list_chats',
    'new_chat',
    'switch_chat',
    'set_mode',
    'change_model',
    'set_thought_level',
    'resolve_action',
    'select_session',
    'open_panel',
    'pty_input',
    'pty_resize',
    'invoke_provider_script',
];

const LEGACY_CDP_COMMANDS = ['send_chat', 'read_chat', 'list_chats', 'new_chat', 'switch_chat', 'set_mode', 'change_model', 'set_thought_level', 'resolve_action'];

/** handler.ts `isReadOrDebugCmd` — the inactive-history fallback. */
const LEGACY_INACTIVE_HISTORY_COMMANDS = ['read_chat', 'get_chat_debug_bundle'];

function legacyShouldFastFlushLaunchStatus(commandType: string, result: { success?: unknown } | null | undefined): boolean {
    if (!result || result.success !== true) return false;
    return commandType === 'launch_cli'
        || commandType === 'launch_ide'
        || commandType === 'interactive_prompt_response';
}

const LEGACY_GIT_COMMAND_NAMES = [
    'git_status',
    'git_diff_summary',
    'git_diff_file',
    'git_snapshot_create',
    'git_snapshot_compare',
    'git_log',
    'git_checkpoint',
    'git_stash_push',
    'git_stash_pop',
    'git_checkout_files',
    'git_remote_url',
    'git_push',
];

function legacyCommandMayAffectMeshGraphStatus(command: string): boolean {
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

// `get_status_metadata` was in the legacy table; it is a read and intentionally no
// longer invalidates daemon.metadata (wiring-unification B4, ipc-load-audit row 8).
const LEGACY_DAEMON_METADATA_COMMANDS: ReadonlySet<string> = new Set([
    'cleanup_mesh_sessions',
    'set_conversation_prefs',
    'invoke_provider_script',
    'set_user_name',
    'set_machine_nickname',
]);

const LEGACY_SESSION_MODAL_COMMANDS: ReadonlySet<string> = new Set([
    'resolve_action',
    'send_chat',
    'read_chat',
]);

function legacyCommandInvalidations(command: string): ReadonlySet<string> {
    if (typeof command !== 'string' || !command) return new Set();
    const topics = new Set<string>();
    if (
        LEGACY_DAEMON_METADATA_COMMANDS.has(command)
        || command.startsWith('workspace_')
        || command.startsWith('session_host_')
        || legacyCommandMayAffectMeshGraphStatus(command)
    ) {
        topics.add('daemon.metadata');
    }
    if (command.startsWith('session_host_')) topics.add('session_host.diagnostics');
    if (LEGACY_SESSION_MODAL_COMMANDS.has(command)) topics.add('session.modal');
    if (command.startsWith('git_')) topics.add('workspace.git');
    return topics;
}

/** handler.ts dispatch switch cases. */
const LEGACY_HANDLER_COMMANDS = [
    'read_chat', 'expand_tool_block', 'get_chat_debug_bundle', 'chat_history', 'send_chat', 'cancel_queued_chat',
    'list_chats', 'new_chat', 'switch_chat', 'set_mode', 'change_model', 'set_thought_level', 'resolve_action',
    'cdp_eval', 'cdp_screenshot', 'screenshot', 'cdp_command_exec', 'cdp_batch', 'cdp_remote_action',
    'cdp_discover_agents', 'cdp_dom_dump', 'cdp_dom_query', 'cdp_dom_debug', 'file_read', 'file_write', 'file_list',
    'file_list_browse', 'workspace_list', 'workspace_add', 'workspace_remove', 'workspace_set_label',
    'registry_catalog', 'workspace_set_default', 'refresh_scripts', 'list_provider_availability',
    'install_provider_manifest', 'uninstall_provider_manifest', 'check_provider_updates',
    'activate_provider_updates', 'rollback_provider_update', 'list_installed_providers', 'add_provider_source',
    'remove_provider_source', 'list_provider_sources', 'set_active_provider_source', 'select_session', 'open_panel',
    'pty_input', 'pty_resize', 'read_terminal', 'send_keys', 'get_provider_settings', 'set_provider_setting',
    'get_provider_source_config', 'set_provider_source_config', 'get_ide_extensions', 'set_ide_extension',
    'invoke_provider_script', 'provider_auto_fix', 'provider_auto_fix_cancel', 'provider_auto_fix_status',
    'provider_clone',
];

/** low-family/index.ts lowFamilyRegistry keys. */
const LEGACY_LOW_FAMILY_COMMANDS = [
    'session_host_get_diagnostics', 'session_host_list_sessions', 'session_host_stop_session',
    'session_host_resume_session', 'session_host_restart_session', 'session_host_send_signal',
    'session_host_force_detach_client', 'session_host_prune_duplicate_sessions', 'session_host_acquire_write',
    'session_host_release_write', 'get_spec_debug', 'get_spec_source', 'write_spec_source', 'validate_spec',
    'eval_condition_preview', 'resolve_section_preview', 'get_mesh_refine_config_schema',
    'validate_mesh_refine_config', 'suggest_mesh_refine_config', 'get_mesh_change_impact_config_schema',
    'validate_mesh_change_impact_config', 'suggest_mesh_change_impact_config', 'get_logs', 'get_debug_trace',
    'set_user_name', 'get_status_metadata', 'refresh_provider_quota', 'get_machine_runtime_stats',
    'get_session_info', 'coordinator_prompt_preview', 'list_coordinator_prompts', 'write_coordinator_prompt',
    'mark_session_seen', 'delete_notification', 'mark_notification_unread', 'daemon_upgrade', 'daemon_restart',
    'set_machine_nickname', 'get_quota_account_label', 'set_quota_account_label', 'get_quota_provider_enabled',
    'set_quota_provider_enabled', 'get_mesh_ledger', 'get_mesh_ledger_slice', 'list_mesh_notes',
    'record_mesh_note', 'forget_mesh_note', 'get_mesh_node_logs',
    'worker_resolve_task', 'worker_report_completion', 'worker_progress_update', 'deposit_worker_mailbox',
    'worker_drain_mailbox', 'worker_peer_context_pull', 'ensure_transcript_subscription',
    'read_transcript_replica',
    // NOT a legacy-table migration: G2 transcript-transport selection
    // reporting (wiring-unification G2b, 2026-09-24,
    // commands/low-family/transcript-transport-report.ts). The dashboard
    // reports which transport (replica vs legacy) it actually used, once per
    // subscription health transition, over the same P2P `type:'command'`
    // frame every other low-family command uses — see
    // `seqscribe/transcript-transport-selection.ts`'s header. Listed here so
    // this test's exhaustive low-family enumeration stays accurate.
    'report_transcript_transport',
    // NOT a legacy-table migration: `get_runtime_snapshot` and `get_command_history`
    // never lived in daemon-core's low-family tables — they were a cloud-only P2P
    // special case in packages/daemon-cloud/src/cloud-command-transports.ts
    // (handleP2POnlyCommand), never routed through this registry at all. Moved onto
    // the shared registry (wiring-unification B residue cleanup, deliverable 7) so
    // standalone gains them too; `sources: ['p2p']` on both specs preserves the
    // original "sensitive, never relayed by the server" property. Listed here
    // (rather than skipped) so this test's exhaustive low-family enumeration below
    // stays accurate, with this comment as the deliberate-change record.
    'get_runtime_snapshot', 'get_command_history',
    // NOT a legacy-table migration either: the turn-ledger IPC surface
    // (wiring-unification C2 / C-W6, commands/low-family/turn-ledger-ipc.ts) —
    // the MCP server's only path to the turn ledger, mesh records, the topic
    // index and missions now that it may not open mesh-runtime.db itself
    // (check:boundaries C8). IPC-only: pinned by the `sources` test below.
    'turn_observe', 'mesh_record', 'turn_cancel', 'operator_status', 'turn_query',
    'mesh_index_query', 'mission_upsert', 'mission_query', 'note_upsert', 'note_forget',
    // C-W9b / C-W9a: the store commands (mesh-store-ipc.ts) — records, queue
    // composites, missions list, active work, recovery hints. IPC-only too.
    'tool_call_record', 'ledger_query', 'mission_list_query', 'record_local', 'queue_query',
    'queue_enqueue', 'queue_enqueue_graph', 'queue_cancel', 'queue_requeue', 'direct_dispatch_record',
    'graph_audit_record', 'active_work_query', 'recovery_context_query',
    // C-W9c: the graph/stats/prune commands (mesh-graph-ipc.ts) — the last
    // mcp-server in-process daemon-core paths: graph gates/plan/patch, task/mission
    // stats, one prune audit, orphaned-pin notify. IPC-only too.
    'graph_gate_claim', 'graph_gate_release', 'graph_gate_abandon', 'graph_node_patch',
    'graph_view_query', 'task_stats_query', 'prune_stale_direct', 'orphaned_pin_notify',
];

/** The turn-ledger IPC commands: reachable ONLY over the local IPC source. */
const TURN_LEDGER_IPC_COMMANDS = [
    'turn_observe', 'mesh_record', 'turn_cancel', 'operator_status', 'turn_query',
    'mesh_index_query', 'mission_upsert', 'mission_query', 'note_upsert', 'note_forget',
    // C-W9b / C-W9a: the store commands (mesh-store-ipc.ts) — records, queue
    // composites, missions list, active work, recovery hints. IPC-only too.
    'tool_call_record', 'ledger_query', 'mission_list_query', 'record_local', 'queue_query',
    'queue_enqueue', 'queue_enqueue_graph', 'queue_cancel', 'queue_requeue', 'direct_dispatch_record',
    'graph_audit_record', 'active_work_query', 'recovery_context_query',
    // C-W9c: the graph/stats/prune commands (mesh-graph-ipc.ts).
    'graph_gate_claim', 'graph_gate_release', 'graph_gate_abandon', 'graph_node_patch',
    'graph_view_query', 'task_stats_query', 'prune_stale_direct', 'orphaned_pin_notify',
];

/** med-family/index.ts medFamilyRegistry keys. */
const LEGACY_MED_FAMILY_COMMANDS = [
    'launch_cli', 'stop_cli', 'set_cli_view_mode', 'record_provider_pty', 'set_conversation_prefs',
    'agent_command', 'list_saved_sessions', 'restart_session', 'stop_ide', 'restart_ide', 'launch_ide',
    'detect_provider', 'detect_ides', 'list_meshes', 'get_mesh', 'create_mesh', 'set_mesh_host', 'update_mesh',
    'export_mesh_json_config', 'write_mesh_json_config', 'read_mesh_json_config', 'set_mesh_provider_defaults',
    'delete_mesh', 'magi_kind_panel_list', 'magi_kind_panel_set', 'magi_kind_panel_remove',
    'difficulty_brains_get', 'difficulty_brains_set', 'mesh_quota_routing_get', 'mesh_quota_routing_set',
    'add_mesh_node', 'update_mesh_node', 'cleanup_mesh_sessions', 'remove_mesh_node', 'clone_mesh_node',
    'retry_mesh_node_bootstrap', 'get_mesh_host_pairing', 'configure_mesh_host_pairing',
    'create_mesh_host_pairing_token', 'apply_mesh_host_join', 'join_mesh_host_pairing', 'get_mesh_queue',
    'cancel_mesh_queue_task', 'requeue_mesh_queue_task', 'trigger_mesh_queue', 'mesh_init',
    'plan_mesh_refine_node', 'fast_forward_mesh_node', 'refine_mesh_node', 'batch_refine_mesh_nodes',
    'restart_daemon_node', 'plan_mesh_onboarding', 'cleanup_worktree_nodes', 'mesh_route_preview',
    'mesh_task_output', 'mesh_graph_overview', 'mesh_gate_claim', 'mesh_gate_release', 'mesh_gate_abandon',
];

/** high-family/index.ts highFamilyRegistry keys. */
const LEGACY_HIGH_FAMILY_COMMANDS = [
    'mesh_forward_event', 'get_pending_mesh_events', 'interactive_prompt_response', 'launch_mesh_coordinator',
    'mesh_status', 'get_mesh_review_inbox',
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function sorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort();
}

function namesWhere(predicate: (spec: CommandSpec) => boolean): string[] {
    return sorted(getDaemonCommandRegistry().list().filter(predicate).map((spec) => spec.name));
}

const noop = async () => ({ success: true });

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CommandRegistry.build', () => {
    it('throws on a duplicate command name, naming both families', () => {
        const specs: CommandSpec[] = [
            { name: 'dup_cmd', family: 'low', run: noop },
            { name: 'other_cmd', family: 'med', run: noop },
            { name: 'dup_cmd', family: 'handler', run: noop },
        ];
        expect(() => CommandRegistry.build(specs, [])).toThrow("duplicate command 'dup_cmd' (low vs handler)");
    });

    it('builds when names are unique and resolves get/list', () => {
        const registry = CommandRegistry.build([
            { name: 'a_cmd', family: 'low', run: noop },
            { name: 'b_cmd', family: 'med', run: noop },
        ], []);
        expect(registry.get('a_cmd')?.family).toBe('low');
        expect(registry.get('missing')).toBeUndefined();
        expect(registry.list().map((spec) => spec.name)).toEqual(['a_cmd', 'b_cmd']);
    });

    it('merges prefix defaults into a spec and applies them to unregistered names', () => {
        const registry = CommandRegistry.build([
            { name: 'git_thing', family: 'git', run: noop, invalidates: ['daemon.metadata'] },
        ], COMMAND_PREFIX_DEFAULTS);
        expect(sorted(registry.get('git_thing')!.invalidates!)).toEqual(['daemon.metadata', 'workspace.git']);
        expect(sorted(registry.invalidationsFor('workspace_unknown'))).toEqual(['daemon.metadata']);
        expect(registry.invalidationsFor('plain_unknown').size).toBe(0);
    });

    it('defineCommandSpecs rejects attributes for a name the handler table does not define', () => {
        expect(() => defineCommandSpecs('low', { real_cmd: noop }, { typo_cmd: { postChat: true } }))
            .toThrow("command attributes declared for 'typo_cmd' but no low handler defines it");
    });

    it('the daemon registry builds (no duplicate command across families)', () => {
        expect(() => getDaemonCommandRegistry()).not.toThrow();
    });
});

describe('daemon command registry — golden diff against the legacy tables', () => {
    it('dispatch families: exactly the legacy family maps, handler switch and git allow-list', () => {
        expect(namesWhere((s) => s.family === 'low')).toEqual(sorted(LEGACY_LOW_FAMILY_COMMANDS));
        expect(namesWhere((s) => s.family === 'med')).toEqual(sorted(LEGACY_MED_FAMILY_COMMANDS));
        expect(namesWhere((s) => s.family === 'high')).toEqual(sorted(LEGACY_HIGH_FAMILY_COMMANDS));
        expect(namesWhere((s) => s.family === 'handler')).toEqual(sorted(LEGACY_HANDLER_COMMANDS));
        expect(namesWhere((s) => s.family === 'git')).toEqual(sorted(LEGACY_GIT_COMMAND_NAMES));
        expect(getDaemonCommandRegistry().list()).toHaveLength(
            LEGACY_LOW_FAMILY_COMMANDS.length + LEGACY_MED_FAMILY_COMMANDS.length + LEGACY_HIGH_FAMILY_COMMANDS.length
            + LEGACY_HANDLER_COMMANDS.length + LEGACY_GIT_COMMAND_NAMES.length,
        );
    });

    it('CHAT_COMMANDS == postChat', () => {
        expect(namesWhere((s) => s.postChat === true)).toEqual(sorted(LEGACY_CHAT_COMMANDS));
    });

    it('MESH_FORWARDABLE_SESSION_COMMANDS == forwardToOwner', () => {
        expect(namesWhere((s) => s.forwardToOwner === true)).toEqual(sorted(LEGACY_MESH_FORWARDABLE_SESSION_COMMANDS));
    });

    it('MANDATORY_UPDATE_BLOCKED_COMMANDS == blockedDuringMandatoryUpdate', () => {
        expect(namesWhere((s) => s.blockedDuringMandatoryUpdate === true)).toEqual(sorted(LEGACY_MANDATORY_UPDATE_BLOCKED_COMMANDS));
    });

    it('SESSION_TARGET_COMMANDS == session.aliasSessionId', () => {
        expect(namesWhere((s) => s.session?.aliasSessionId === true)).toEqual(sorted(LEGACY_SESSION_TARGET_COMMANDS));
    });

    it('sessionScopedCommands == session.scope required; cdpCommands == session.requireRoute', () => {
        expect(namesWhere((s) => s.session?.scope === 'required')).toEqual(sorted(LEGACY_SESSION_SCOPED_COMMANDS));
        expect(namesWhere((s) => s.session?.requireRoute === true)).toEqual(sorted(LEGACY_CDP_COMMANDS));
        expect(namesWhere((s) => s.session?.allowInactiveHistory === true)).toEqual(sorted(LEGACY_INACTIVE_HISTORY_COMMANDS));
    });

    it('shouldFastFlushLaunchStatus == fastFlush (the host still requires success)', () => {
        const allNames = getDaemonCommandRegistry().list().map((s) => s.name);
        expect(namesWhere((s) => s.fastFlush === true))
            .toEqual(sorted(allNames.filter((name) => legacyShouldFastFlushLaunchStatus(name, { success: true }))));
    });

    it('commandInvalidations + commandMayAffectMeshGraphStatus == invalidationsFor, for every registered name', () => {
        const registry = getDaemonCommandRegistry();
        const mismatches: string[] = [];
        for (const spec of registry.list()) {
            const expected = sorted(legacyCommandInvalidations(spec.name));
            const actual = sorted(registry.invalidationsFor(spec.name));
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                mismatches.push(`${spec.name}: legacy=${expected.join('|')} registry=${actual.join('|')}`);
            }
        }
        expect(mismatches).toEqual([]);
    });

    it('invalidationsFor matches the legacy table for unregistered names too (prefix rules)', () => {
        const registry = getDaemonCommandRegistry();
        for (const name of [
            'workspace_future', 'session_host_future', 'git_future', 'mesh_future', 'meshless_thing',
            'get_command_history', 'get_runtime_snapshot', 'totally_unknown', '',
        ]) {
            expect(sorted(registry.invalidationsFor(name)), name || '(empty)').toEqual(sorted(legacyCommandInvalidations(name)));
        }
    });
});

describe('turn-ledger IPC commands (C-W6)', () => {
    it('are low-family specs restricted to the ipc source — never ws / p2p / mesh / api', () => {
        for (const name of TURN_LEDGER_IPC_COMMANDS) {
            const spec = getDaemonCommandRegistry().get(name);
            expect(spec?.family, name).toBe('low');
            expect(spec?.sources, name).toEqual(['ipc']);
        }
    });
});

describe('normalizeCommandSource', () => {
    it('keeps mesh / ipc / internal as real sources alongside the transport sources', () => {
        for (const source of ['ws', 'p2p', 'ext', 'api', 'standalone', 'ipc', 'mesh', 'internal']) {
            expect(normalizeCommandSource(source)).toBe(source);
        }
    });

    it('maps anything else to unknown', () => {
        for (const source of ['', 'dashboard', 'MESH', undefined, null, 42]) {
            expect(normalizeCommandSource(source)).toBe('unknown');
        }
    });
});
