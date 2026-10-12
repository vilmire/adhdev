import { isVisible, messageText } from './project-views.js';
import type { AssistantProjectPorts } from './assistant-project-ports.js';
import { readTerminalEvents, TerminalWatchStore, deliverTerminalEvents, type TerminalEvent, type TerminalWatch, type TerminalDeliveryIntent } from './terminal-watch.js';

export async function pendingTerminalEvents(store: TerminalWatchStore, ports: AssistantProjectPorts, watch: TerminalWatch): Promise<TerminalEvent[]> {
    const mesh = ports.listMeshes().find(m => m.id === watch.mesh_id);
    if (!mesh) return []; // revoked roster/project: no delivery
    const receipts = store.receipts(watch.watch_id);
    if (receipts.length >= 256) throw new Error('terminal_watch_receipt_capacity');
    if (ports.isHostedHere(mesh)) return readTerminalEvents(store.db, mesh.id, watch.kind, watch.entity_id, 0, receipts).map(e => ({ ...e, sourceDaemonId: ports.selfDaemonId?.() ?? null }));
    const remote = ports.remoteHost(mesh);
    if (!remote.reachable) throw new Error(remote.reason ?? 'terminal_watch_remote_unreachable');
    const out = await ports.callHost(remote, 'terminal', { kind: watch.kind, entityId: watch.entity_id, receipts });
    if (!out.ok) throw new Error(out.error);
    const result = out.result.result as { events?: unknown } | undefined;
    if (!Array.isArray(result?.events)) throw new Error('terminal_watch_invalid_remote_events');
    // Remote metadata never introduces an authority or a content field.
    const normalized = result.events.slice(0, 16).map(raw => {
        const r = raw as TerminalEvent;
        const id = (v: unknown) => typeof v === 'string' && v.length <= 200 ? v : null;
        if (!id(r.eventId) || r.meshId !== remote.hostMeshId || !Number.isFinite(r.at)
            || !['task_completed','task_failed','task_cancelled','mission_status_changed','mission_created'].includes(r.kind)
            || (watch.kind === 'task' ? r.taskId !== watch.entity_id || !['task_completed','task_failed','task_cancelled'].includes(r.kind)
                : r.missionId !== watch.entity_id || !['mission_status_changed','mission_created'].includes(r.kind) || !['completed','abandoned'].includes(r.outcome ?? ''))) throw new Error('terminal_watch_invalid_remote_identity');
        return { eventId: r.eventId, meshId: mesh.id, taskId: id(r.taskId), missionId: id(r.missionId),
            sessionId: id(r.sessionId), nodeId: id(r.nodeId), kind: r.kind, at: r.at, sourceMeshId: remote.hostMeshId, sourceDaemonId: remote.hostDaemonId,
            outcome: watch.kind === 'task' ? r.kind.slice(5) : r.outcome };
    }).filter(e => !receipts.includes(e.eventId));
    return [...new Map(normalized.map(e => [e.eventId, e])).values()].sort((a, b) => a.at - b.at || a.eventId.localeCompare(b.eventId));
}

export class TerminalWatchDelivery {
    private running = false;
    constructor(private store: TerminalWatchStore, private ports: () => Promise<AssistantProjectPorts>,
        private recipient: () => string | null, private ready: (sid: string) => boolean,
        private submit: (sid: string, messageId: string, text: string) => Promise<boolean>) {}
    async tick(): Promise<void> {
        if (this.running) return;
        const sid = this.recipient(); if (!sid || !this.ready(sid)) return;
        this.running = true;
        try {
            const ports = await this.ports();
            for (const watch of this.store.list('assistant')) {
                if (!this.ready(sid) || this.recipient() !== sid) break;
                let events: TerminalEvent[];
                try { events = await pendingTerminalEvents(this.store, ports, watch); } catch { continue; }
                await deliverTerminalEvents(events, watch, async (id, text) => {
                    if (!this.ready(sid) || this.recipient() !== sid) return false;
                    return this.submit(sid, id, text);
                }, this.store, { recipient: sid, confirm: intent => confirmTerminalDelivery(ports, intent) });
            }
        } finally { this.running = false; }
    }
}

/** Exact recipient + random daemon marker, user input bubble only. Never infer delivery from a provider reply. */
export async function confirmTerminalDelivery(ports: AssistantProjectPorts, intent: TerminalDeliveryIntent): Promise<boolean> {
    const matches = (chat: Record<string, unknown>) => (Array.isArray(chat.messages) ? chat.messages : []).some((m: any) =>
        m?.role === 'user' && isVisible(m)
        && messageText(m).includes('[ADHDev task/mission terminal]') && messageText(m).includes(`"deliveryToken":"${intent.token}"`));
    const chat = await ports.execute('read_chat', { targetSessionId: intent.recipient_session_id, limit: 200 });
    if (chat.success && matches(chat)) return true;
    for (let offset = 0; offset < 400; offset += 100) {
        const history = await ports.execute('chat_history', { targetSessionId: intent.recipient_session_id, offset, limit: 100, excludeRecentCount: 0 });
        if (!history.success) return false;
        if (matches(history)) return true;
        if (history.hasMore !== true) break;
    }
    return false;
}
