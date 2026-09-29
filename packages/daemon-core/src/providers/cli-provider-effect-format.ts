// Message-formatting helpers extracted from cli-provider-instance.ts. None of
// these use any instance state. (Effect dedup lives with the other provider
// effect helpers in control-effects.ts.)

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
