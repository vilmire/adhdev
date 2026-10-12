import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { assistantToolGate, ASSISTANT_TOOL_SOURCES, projectPortsFor, readAssistantSessionId } from './assistant-store.js';
import { resolveAssistantProject } from '../../assistant/assistant-projects.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { terminalRetryIdentity, TerminalWatchStore } from '../../assistant/terminal-watch.js';
import { pendingTerminalEvents } from '../../assistant/terminal-watch-runtime.js';
import type { HighFamilyHandler } from './types.js';

const watch: HighFamilyHandler = async (ctx, args) => {
    const gate = assistantToolGate(ASSISTANT_VERB.watch, args); if (gate) return gate;
    const recipient = readAssistantSessionId(args);
    const bound = getAssistantRegistry().reload()?.sessionId;
    if (!recipient || recipient !== bound) return { success: false, code: 'assistant_session_required' };
    const ports = await projectPortsFor(ctx);
    await ports.refreshMemberMeshes?.();
    const project = resolveAssistantProject(args.project, ports.listMeshes(), ports.aliases());
    if (!project.ok) return { success: false, code: project.code };
    const store = new TerminalWatchStore(MeshRuntimeStore.getInstance().db);
    if (args.action === 'subscribe') {
        if (!['task', 'mission'].includes(args.kind) || typeof args.entityId !== 'string' || !args.entityId || args.entityId.length > 200) return { success: false, code: 'invalid_args' };
        return { ...store.subscribe(project.mesh.id, args.kind, args.entityId, 'assistant'), meshId: project.mesh.id };
    }
    if (args.action === 'list') return { success: true, watches: store.list('assistant').filter(w => w.mesh_id === project.mesh.id) };
    const owned = typeof args.watchId === 'string' ? store.get(args.watchId) : undefined;
    if (!owned || owned.recipient !== 'assistant' || owned.mesh_id !== project.mesh.id || owned.expires_at <= Date.now()) return { success: false, code: 'terminal_watch_not_found' };
    if (args.action === 'acknowledge') {
        if (typeof args.eventId !== 'string' || typeof args.deliveryToken !== 'string') return { success: false, code: 'invalid_args' };
        const intent = store.intent(owned.watch_id, args.eventId);
        if (!intent && store.receipts(owned.watch_id).includes(args.eventId)) return { success: true, duplicate: true };
        if (!intent || intent.token !== args.deliveryToken || intent.recipient_session_id !== recipient) return { success: false, code: 'terminal_receipt_token_mismatch' };
        store.acknowledge(owned.watch_id, args.eventId);
        return { success: true };
    }
    if (args.action === 'retry_delivery') {
        if (typeof args.eventId !== 'string' || !store.intent(owned.watch_id, args.eventId)) return { success: false, code: 'terminal_delivery_intent_not_found' };
        if (args.retryIdentity !== terminalRetryIdentity(store.intent(owned.watch_id, args.eventId)!)) return { success: false, code: 'terminal_delivery_intent_changed' };
        store.retryDelivery(owned.watch_id, args.eventId);
        return { success: true, warning: 'Delivery was unconfirmed; retry retains the same event identity and may repeat a notice.' };
    }
    if (args.action === 'unsubscribe') { store.unsubscribe(owned.watch_id); return { success: true }; }
    // Reading pending events NEVER consumes them. Native delivery writes receipts after submission.
    if (args.action === 'pending') {
        try { return { success: true, watchId: owned.watch_id, events: (await pendingTerminalEvents(store, ports, owned)).map(event => ({ ...event, deliveryState: store.intent(owned.watch_id, event.eventId) ? 'unconfirmed_native_delivery' : 'pending',
                ...(store.intent(owned.watch_id, event.eventId) ? { originalRecipient: store.intent(owned.watch_id, event.eventId)!.recipient_session_id, startedAt: store.intent(owned.watch_id, event.eventId)!.started_at, retryAction: 'retry_delivery', retryIdentity: terminalRetryIdentity(store.intent(owned.watch_id, event.eventId)!) } : {}) })) }; }
        catch (e) { return { success: false, code: 'terminal_watch_unavailable', error: (e as Error).message }; }
    }
    return { success: false, code: 'invalid_args' };
};
export const assistantWatchSpecs = defineCommandSpecs('high', { [ASSISTANT_VERB.watch]: watch }, { [ASSISTANT_VERB.watch]: { sources: [...ASSISTANT_TOOL_SOURCES] } });
