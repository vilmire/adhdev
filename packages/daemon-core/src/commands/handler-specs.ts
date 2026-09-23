/**
 * Command specs dispatched through {@link DaemonCommandHandler}: chat, CDP,
 * file, workspace, provider-management, stream / PTY, provider-settings and
 * DevServer-proxy commands, plus the git commands.
 *
 * The handler owns the per-request route (target session / CDP manager /
 * provider type), manual-attendance stamping and the session pre-checks that
 * `session` attributes select; `run` is only the command body.
 */
import * as Chat from './chat-commands.js';
import * as Cdp from './cdp-commands.js';
import * as Stream from './stream-commands.js';
import * as WorkspaceCmd from './workspace-commands.js';
import { handleGitCommand } from '../git/git-commands.js';
import type { GitCommandName } from '../git/git-types.js';
import type { CommandRouterResult } from './router.js';
import { defineCommandSpecs, type CommandSpec } from './command-registry.js';
import type { DaemonCommandHandler } from './handler.js';

type HandlerRun = (h: DaemonCommandHandler, args: any) => Promise<CommandRouterResult>;

/** Lift the sync / narrower-typed command bodies onto the spec `run` shape. */
function run(body: (h: DaemonCommandHandler, args: any) => CommandRouterResult | Promise<CommandRouterResult>): HandlerRun {
    return async (h, args) => body(h, args);
}

const handlerCommands: Record<string, HandlerRun> = {
    // ─── Chat commands (chat-commands.ts) ───────────────
    read_chat: run((h, a) => Chat.handleReadChat(h, a)),
    expand_tool_block: run((h, a) => Chat.handleExpandToolBlock(h, a)),
    get_chat_debug_bundle: run((h, a) => Chat.handleGetChatDebugBundle(h, a)),
    chat_history: run((h, a) => Chat.handleChatHistory(h, a)),
    send_chat: run((h, a) => Chat.handleSendChat(h, a)),
    cancel_queued_chat: run((h, a) => Chat.handleCancelQueuedChat(h, a)),
    list_chats: run((h, a) => Chat.handleListChats(h, a)),
    new_chat: run((h, a) => Chat.handleNewChat(h, a)),
    switch_chat: run((h, a) => Chat.handleSwitchChat(h, a)),
    set_mode: run((h, a) => Chat.handleSetMode(h, a)),
    change_model: run((h, a) => Chat.handleChangeModel(h, a)),
    set_thought_level: run((h, a) => Chat.handleSetThoughtLevel(h, a)),
    resolve_action: run((h, a) => Chat.handleResolveAction(h, a)),

    // ─── CDP commands (cdp-commands.ts) ───────────────
    cdp_eval: run((h, a) => Cdp.handleCdpEval(h, a)),
    cdp_screenshot: run((h, a) => Cdp.handleScreenshot(h, a)),
    screenshot: run((h, a) => Cdp.handleScreenshot(h, a)),
    cdp_command_exec: run((h, a) => Cdp.handleCdpCommand(h, a)),
    cdp_batch: run((h, a) => Cdp.handleCdpBatch(h, a)),
    cdp_remote_action: run((h, a) => Cdp.handleCdpRemoteAction(h, a)),
    cdp_discover_agents: run((h, a) => Cdp.handleDiscoverAgents(h, a)),
    cdp_dom_dump: run((h, a) => h.domHandlers.handleDomDump(a)),
    cdp_dom_query: run((h, a) => h.domHandlers.handleDomQuery(a)),
    cdp_dom_debug: run((h, a) => h.domHandlers.handleDomDebug(a)),

    // ─── File commands (cdp-commands.ts) ──────────────
    file_read: run((h, a) => Cdp.handleFileRead(h, a)),
    file_write: run((h, a) => Cdp.handleFileWrite(h, a)),
    file_list: run((h, a) => Cdp.handleFileList(h, a)),
    file_list_browse: run((h, a) => Cdp.handleFileListBrowse(h, a)),

    // ─── Workspace commands ──────────────
    workspace_list: run(() => WorkspaceCmd.handleWorkspaceList()),
    workspace_add: run((_h, a) => WorkspaceCmd.handleWorkspaceAdd(a)),
    workspace_remove: run((_h, a) => WorkspaceCmd.handleWorkspaceRemove(a)),
    workspace_set_label: run((_h, a) => WorkspaceCmd.handleWorkspaceSetLabel(a)),
    registry_catalog: run((h, a) => h.handleRegistryCatalog(a)),
    workspace_set_default: run((_h, a) => WorkspaceCmd.handleWorkspaceSetDefault(a)),

    // ─── Provider script / manifest management ───────────────────
    refresh_scripts: run((h, a) => h.handleRefreshScripts(a)),
    list_provider_availability: run((h, a) => h.handleListProviderAvailability(a)),
    install_provider_manifest: run((h, a) => h.handleInstallProviderManifest(a)),
    uninstall_provider_manifest: run((h, a) => h.handleUninstallProviderManifest(a)),
    check_provider_updates: run((h, a) => h.handleCheckProviderUpdates(a)),
    activate_provider_updates: run((h, a) => h.handleActivateProviderUpdates(a)),
    rollback_provider_update: run((h, a) => h.handleRollbackProviderUpdate(a)),
    list_installed_providers: run((h, a) => h.handleListInstalledProviders(a)),
    add_provider_source: run((h, a) => h.handleAddProviderSource(a)),
    remove_provider_source: run((h, a) => h.handleRemoveProviderSource(a)),
    list_provider_sources: run((h, a) => h.handleListProviderSources(a)),
    set_active_provider_source: run((h, a) => h.handleSetActiveProviderSource(a)),

    // ─── Stream commands (stream-commands.ts) ───────────
    select_session: run((h, a) => Stream.handleSelectSession(h, a)),
    open_panel: run((h, a) => Stream.handleOpenPanel(h, a)),

    // ─── PTY raw I/O (stream-commands.ts) ─────────
    pty_input: run((h, a) => Stream.handlePtyInput(h, a)),
    pty_resize: run((h, a) => Stream.handlePtyResize(h, a)),
    // MESH-READ-TERMINAL (feature 2): raw viewport read
    read_terminal: run((h, a) => Stream.handleReadTerminal(h, a)),
    // MESH-SEND-KEYS (feature 3): structured key injection
    send_keys: run((h, a) => Stream.handleSendKeys(h, a)),

    // ─── Provider settings (stream-commands.ts) ──────────
    get_provider_settings: run((h, a) => Stream.handleGetProviderSettings(h, a)),
    set_provider_setting: run((h, a) => Stream.handleSetProviderSetting(h, a)),
    get_provider_source_config: run((h, a) => Stream.handleGetProviderSourceConfig(h, a)),
    set_provider_source_config: run((h, a) => Stream.handleSetProviderSourceConfig(h, a)),

    // ─── IDE extension settings (stream-commands.ts) ──────────
    get_ide_extensions: run((h, a) => Stream.handleGetIdeExtensions(h, a)),
    set_ide_extension: run((h, a) => Stream.handleSetIdeExtension(h, a)),

    // ─── Provider control execution (stream-commands.ts) ──────────
    invoke_provider_script: run((h, a) => Stream.handleProviderScript(h, a)),

    // ─── Provider auto-fix / clone (DevServer proxy) ──────────
    provider_auto_fix: run((h, a) => h.proxyDevServerPost(a, 'auto-implement')),
    provider_auto_fix_cancel: run((h, a) => h.proxyDevServerPost(a, 'auto-implement/cancel')),
    provider_auto_fix_status: run((h, a) => h.proxyDevServerGet(a, 'auto-implement/status')),
    provider_clone: run((h, a) => h.proxyDevServerScaffold(a)),
};

/** A command addressing ONE live session that fails closed when it is gone and needs a route. */
const REQUIRED_ROUTED = { scope: 'required', requireRoute: true } as const;

export const handlerSpecs: CommandSpec<'handler'>[] = defineCommandSpecs('handler', handlerCommands, {
    read_chat: {
        // Serves historical transcript data when the live session is gone.
        session: { ...REQUIRED_ROUTED, aliasSessionId: true, allowInactiveHistory: true },
        invalidates: ['session.modal'],
    },
    get_chat_debug_bundle: {
        session: { scope: 'required', aliasSessionId: true, allowInactiveHistory: true },
    },
    // (TOOL-EXPAND) Addresses ONE session's transcript file. Failing closed when that
    // session is gone is the point: resolving the ref against whatever session is current
    // instead would expand the wrong transcript.
    expand_tool_block: { session: { scope: 'required', aliasSessionId: true } },
    chat_history: { session: { scope: 'optional', aliasSessionId: true } },
    send_chat: {
        session: { ...REQUIRED_ROUTED, aliasSessionId: true },
        invalidates: ['session.modal'],
        postChat: true,
    },
    // Cancelling a queued send addresses ONE session's driver FIFO, so it fails closed
    // exactly like send_chat when the session is gone. It must reach the OWNING worker:
    // the parked body lives in that daemon's driver FIFO, and unlike send_chat it has no
    // route of its own to get there.
    cancel_queued_chat: {
        session: { scope: 'required', aliasSessionId: true },
        forwardToOwner: true,
    },
    list_chats: { session: REQUIRED_ROUTED },
    new_chat: { session: REQUIRED_ROUTED, postChat: true },
    switch_chat: { session: REQUIRED_ROUTED, postChat: true },
    set_mode: { session: REQUIRED_ROUTED, postChat: true, forwardToOwner: true },
    change_model: { session: REQUIRED_ROUTED, postChat: true, forwardToOwner: true },
    set_thought_level: { session: REQUIRED_ROUTED, forwardToOwner: true },
    // Approve / reject a modal prompt.
    resolve_action: {
        session: { ...REQUIRED_ROUTED, aliasSessionId: true },
        invalidates: ['session.modal'],
        forwardToOwner: true,
    },
    select_session: { session: { scope: 'required' } },
    open_panel: { session: { scope: 'required' } },
    pty_input: { session: { scope: 'required' } },
    pty_resize: { session: { scope: 'required' } },
    // Controlbar Model/Mode selectors run a provider script against one session.
    invoke_provider_script: {
        session: { scope: 'required' },
        invalidates: ['daemon.metadata'],
        forwardToOwner: true,
    },
    // mesh_read_terminal: the live viewport lives ONLY on the owning session's adapter.
    read_terminal: { forwardToOwner: true },
    // mesh_send_keys MUTATES the worker PTY, so reaching the real owner (not a wrong local
    // session) matters doubly. The owning daemon re-enforces the destructive-key confirm gate.
    send_keys: { forwardToOwner: true },
});

/**
 * Exactly the members of {@link GitCommandName} — the compiler rejects a
 * missing or an extra key, so the generated specs track the git allow-list.
 */
const GIT_COMMAND_KEYS: Record<GitCommandName, true> = {
    git_status: true,
    git_diff_summary: true,
    git_diff_file: true,
    git_snapshot_create: true,
    git_snapshot_compare: true,
    git_log: true,
    git_checkpoint: true,
    git_stash_push: true,
    git_stash_pop: true,
    git_checkout_files: true,
    git_remote_url: true,
    git_push: true,
};

export const gitSpecs: CommandSpec<'git'>[] = (Object.keys(GIT_COMMAND_KEYS) as GitCommandName[]).map((name) => ({
    name,
    family: 'git' as const,
    run: async (services, args) => handleGitCommand(name, args, services) as Promise<CommandRouterResult>,
}));
