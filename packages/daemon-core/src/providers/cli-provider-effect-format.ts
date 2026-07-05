// Provider-effect dedup and message-formatting helpers extracted from
// cli-provider-instance.ts. Pure move — no behavior change. None of these used
// any instance state; they were private methods invoked only within the class.

export function getEffectDedupKey(effect: { id?: string; type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string } }): string {
    if (effect.id) return `provider_effect:${effect.id}`;
    if (effect.type === 'message') {
        const content = typeof effect.message?.content === 'string'
            ? effect.message.content
            : JSON.stringify(effect.message?.content || '');
        return `provider_effect:message:${content}`;
    }
    if (effect.type === 'notification') {
        return `provider_effect:notification:${effect.notification?.title || ''}:${effect.notification?.body || ''}`;
    }
    return `provider_effect:toast:${effect.toast?.message || ''}`;
}

export function getPersistedEffectContent(effect: { type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string; bubbleContent?: unknown } }): string | null {
    if (effect.type === 'message') {
        return typeof effect.message?.content === 'string'
            ? effect.message.content
            : JSON.stringify(effect.message?.content || '');
    }
    if (effect.type === 'toast') {
        return effect.toast?.message || null;
    }
    if (effect.type === 'notification') {
        if (typeof effect.notification?.bubbleContent === 'string') return effect.notification.bubbleContent;
        if (typeof effect.notification?.title === 'string' && effect.notification.title.trim()) {
            return `${effect.notification.title}\n${effect.notification.body || ''}`.trim();
        }
        return effect.notification?.body || null;
    }
    return null;
}

export function formatApprovalRequestMessage(modalMessage?: string, buttons?: string[]): string {
    const lines = ['Approval requested'];
    const cleanMessage = String(modalMessage || '').trim();
    if (cleanMessage) lines.push(cleanMessage);
    const labels = (buttons || []).map((button) => String(button || '').trim()).filter(Boolean);
    if (labels.length > 0) {
        lines.push(labels.map((label) => `[${label}]`).join(' '));
    }
    return lines.join('\n');
}

export function formatMarkerTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
