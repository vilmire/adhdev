import { describe, expect, it } from 'vitest';
import {
    commandInvalidations,
    commandMayAffectMeshGraphStatus,
} from '../../src/commands/command-invalidations.js';

describe('commandInvalidations — command → subscription-flush table (single source of truth)', () => {
    it('mesh-graph commands invalidate daemon.metadata (the divergence that made cloud dashboards stale)', () => {
        for (const cmd of [
            'mesh_enqueue_task',
            'mesh_fast_forward_node',
            'add_mesh_node',
            'update_mesh_node',
            'remove_mesh_node',
            'clone_mesh_node',
            'trigger_mesh_queue',
            'get_mesh_queue',
            'launch_cli',
            'stop_cli',
            'restart_session',
        ]) {
            expect(commandMayAffectMeshGraphStatus(cmd), cmd).toBe(true);
            expect(commandInvalidations(cmd).has('daemon.metadata'), cmd).toBe(true);
        }
    });

    it('identity commands (set_user_name / set_machine_nickname) invalidate daemon.metadata', () => {
        for (const cmd of ['set_user_name', 'set_machine_nickname']) {
            expect(commandInvalidations(cmd).has('daemon.metadata'), cmd).toBe(true);
        }
    });

    it('keeps the incident-driven metadata entries (ghost-linger, hidden-mute-stick, provider script, status read)', () => {
        for (const cmd of [
            'cleanup_mesh_sessions',   // DASHBOARD-GHOST-LINGER
            'set_conversation_prefs',  // HIDDEN-MUTE-STICK
            'invoke_provider_script',
            'get_status_metadata',
        ]) {
            expect(commandInvalidations(cmd).has('daemon.metadata'), cmd).toBe(true);
        }
    });

    it('workspace_ and session_host_ prefixed commands invalidate daemon.metadata', () => {
        expect(commandInvalidations('workspace_list').has('daemon.metadata')).toBe(true);
        expect(commandInvalidations('session_host_restart').has('daemon.metadata')).toBe(true);
    });

    it('session_host_ commands additionally invalidate session_host.diagnostics', () => {
        const topics = commandInvalidations('session_host_restart');
        expect(topics.has('session_host.diagnostics')).toBe(true);
        expect(commandInvalidations('workspace_list').has('session_host.diagnostics')).toBe(false);
    });

    it('chat/approval commands invalidate session.modal', () => {
        for (const cmd of ['resolve_action', 'send_chat', 'read_chat']) {
            expect(commandInvalidations(cmd).has('session.modal'), cmd).toBe(true);
        }
        expect(commandInvalidations('chat_history').has('session.modal')).toBe(false);
    });

    it('git_ commands invalidate workspace.git', () => {
        expect(commandInvalidations('git_status').has('workspace.git')).toBe(true);
        expect(commandInvalidations('git_status').has('daemon.metadata')).toBe(false);
    });

    it('unrelated / read-only commands invalidate nothing', () => {
        for (const cmd of ['get_command_history', 'chat_history', 'detect_ides', 'screenshot', '', 'get_runtime_snapshot']) {
            expect(commandInvalidations(cmd).size, cmd || '(empty)').toBe(0);
        }
    });

    it('mesh-graph predicate stays scoped (no false positives on similar names)', () => {
        for (const cmd of ['meshless_thing', 'cleanup_mesh_sessions', 'get_status_metadata']) {
            expect(commandMayAffectMeshGraphStatus(cmd), cmd).toBe(false);
        }
    });
});
