/**
 * Mesh sender policy (commands/mesh-sender.ts): every command the router will
 * run with source `mesh` must DECLARE who may send it (`meshSender`). A
 * command that accepts `mesh` without a class is refused at run time
 * (`mesh_sender_policy_missing`) — this test catches it at authoring time.
 */
import { describe, expect, it } from 'vitest';
import { getDaemonCommandRegistry } from '../../src/commands/router.js';
import { specAcceptsMeshSource } from '../../src/commands/command-registry.js';
import { MESH_SENDER_CLASSES } from '../../src/commands/mesh-sender.js';

/**
 * The owner-approved classes for the commands the 2026-09-24 audit named, plus
 * the session-driving siblings. Everything else that accepts `mesh` declares
 * `authenticated_peer` (read-only probes / launch — a worker daemon usually
 * holds no roster to check them against).
 */
const EXPECTED_CLASSES: Record<string, string> = {
    // worker → owner
    mesh_forward_event: 'node_owner',
    worker_report_forwarded: 'roster',
    worker_progress_forwarded: 'roster',
    // owner → worker, session-scoped
    agent_command: 'session_coordinator',
    send_keys: 'session_coordinator',
    resolve_action: 'session_coordinator',
    set_mode: 'session_coordinator',
    change_model: 'session_coordinator',
    set_thought_level: 'session_coordinator',
    invoke_provider_script: 'session_coordinator',
    cancel_queued_chat: 'session_coordinator',
    interactive_prompt_response: 'session_coordinator',
    deposit_worker_mailbox: 'session_coordinator',
    read_terminal: 'session_coordinator',
    set_conversation_prefs: 'session_coordinator',
    stop_cli: 'session_coordinator',
    send_chat: 'session_coordinator',
    pty_input: 'session_coordinator',
    pty_resize: 'session_coordinator',
    // node-level mutations / reads on the named mesh
    restart_daemon_node: 'any_member_mesh',
    remove_mesh_node: 'any_member_mesh',
    clone_mesh_node: 'any_member_mesh',
    retry_mesh_node_bootstrap: 'any_member_mesh',
    fast_forward_mesh_node: 'any_member_mesh',
    refine_mesh_node: 'any_member_mesh',
    get_mesh_node_logs: 'any_member_mesh',
    // the joining member is not on the host roster yet
    apply_mesh_host_join: 'pairing_member',
    // launch is open, but a coordinator anchor it stamps must be backed by host evidence
    launch_cli: 'mesh_launch',
};

describe('mesh sender policy — registry', () => {
    const specs = getDaemonCommandRegistry().list();

    it('every command that accepts the mesh source declares a valid meshSender class', () => {
        const missing = specs.filter((s) => specAcceptsMeshSource(s) && !s.meshSender).map((s) => s.name);
        expect(missing).toEqual([]);
        const invalid = specs.filter((s) => s.meshSender && !(MESH_SENDER_CLASSES as readonly string[]).includes(s.meshSender)).map((s) => s.name);
        expect(invalid).toEqual([]);
    });

    it('declares the owner-approved class for each audited command', () => {
        const actual: Record<string, string | undefined> = {};
        for (const name of Object.keys(EXPECTED_CLASSES)) actual[name] = getDaemonCommandRegistry().get(name)?.meshSender;
        expect(actual).toEqual(EXPECTED_CLASSES);
    });

    it('every command with a class other than authenticated_peer is listed above (no silent tightening)', () => {
        const nonDefault = specs
            .filter((s) => s.meshSender && s.meshSender !== 'authenticated_peer')
            .map((s) => s.name)
            .sort();
        expect(nonDefault).toEqual(Object.keys(EXPECTED_CLASSES).sort());
    });

    it('a command that does not accept mesh needs no class (turn IPC is ipc|standalone only)', () => {
        const turnQuery = getDaemonCommandRegistry().get('turn_query');
        expect(turnQuery && specAcceptsMeshSource(turnQuery)).toBe(false);
    });
});
