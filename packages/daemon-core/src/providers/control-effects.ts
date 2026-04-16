import type {
    ControlInvokeResult,
    ControlListResult,
    ControlSetResult,
    ProviderControlDef,
    ProviderControlOption,
    ProviderEffect,
} from './contracts.js';
import { flattenContent } from './contracts.js';
import type { ChatMessage } from '../types.js';
import { buildChatMessage, buildRuntimeSystemChatMessage } from './chat-message-normalization.js';

export type ProviderControlValue = string | number | boolean;

export function extractProviderControlValues(
    controls: ProviderControlDef[] | undefined,
    data: any,
): Record<string, ProviderControlValue> | undefined {
    if (!data || typeof data !== 'object') return undefined;

    const values: Record<string, ProviderControlValue> = {};
    const explicit = data.controlValues;
    if (explicit && typeof explicit === 'object') {
        for (const [key, value] of Object.entries(explicit)) {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                values[key] = value;
            }
        }
    }

    for (const ctrl of controls || []) {
        if (!ctrl.readFrom) continue;
        const rawValue = data[ctrl.readFrom];
        if (rawValue === undefined || rawValue === null) continue;
        values[ctrl.id] = normalizeControlValue(rawValue);
    }

    return Object.keys(values).length > 0 ? values : undefined;
}

export function normalizeProviderEffects(data: any): ProviderEffect[] {
    const rawEffects = Array.isArray(data?.effects) ? data.effects : [];
    const effects: ProviderEffect[] = [];

    for (const raw of rawEffects) {
        if (!raw || typeof raw !== 'object') continue;
        const type = raw.type;
        if (type === 'message' && raw.message && typeof raw.message === 'object') {
            const content = raw.message.content;
            if (typeof content !== 'string' && !Array.isArray(content)) continue;
            effects.push({
                type: 'message',
                id: typeof raw.id === 'string' ? raw.id : undefined,
                when: raw.when === 'turn_completed' ? 'turn_completed' : 'immediate',
                persist: raw.persist !== false,
                message: {
                    role: raw.message.role === 'assistant' || raw.message.role === 'user' ? raw.message.role : 'system',
                    content,
                    kind: typeof raw.message.kind === 'string' ? raw.message.kind : undefined,
                    senderName: typeof raw.message.senderName === 'string' ? raw.message.senderName : undefined,
                },
            });
            continue;
        }

        if (type === 'toast' && raw.toast && typeof raw.toast.message === 'string') {
            effects.push({
                type: 'toast',
                id: typeof raw.id === 'string' ? raw.id : undefined,
                when: raw.when === 'turn_completed' ? 'turn_completed' : 'immediate',
                persist: raw.persist !== false,
                toast: {
                    level: raw.toast.level === 'success' || raw.toast.level === 'warning' ? raw.toast.level : 'info',
                    message: raw.toast.message,
                },
            });
            continue;
        }

        if (type === 'notification' && raw.notification && typeof raw.notification.body === 'string') {
            effects.push({
                type: 'notification',
                id: typeof raw.id === 'string' ? raw.id : undefined,
                when: raw.when === 'turn_completed' ? 'turn_completed' : 'immediate',
                persist: raw.persist !== false,
                notification: {
                    title: typeof raw.notification.title === 'string' ? raw.notification.title : undefined,
                    body: raw.notification.body,
                    level: raw.notification.level === 'success' || raw.notification.level === 'warning' ? raw.notification.level : 'info',
                    channels: Array.isArray(raw.notification.channels)
                        ? raw.notification.channels.filter((channel: unknown) =>
                            channel === 'bubble' || channel === 'toast' || channel === 'browser')
                        : undefined,
                    preferenceKey: raw.notification.preferenceKey === 'disconnect'
                        || raw.notification.preferenceKey === 'completion'
                        || raw.notification.preferenceKey === 'approval'
                        || raw.notification.preferenceKey === 'browser'
                        ? raw.notification.preferenceKey
                        : undefined,
                    bubbleContent: typeof raw.notification.bubbleContent === 'string' || Array.isArray(raw.notification.bubbleContent)
                        ? raw.notification.bubbleContent
                        : undefined,
                    bubbleKind: typeof raw.notification.bubbleKind === 'string'
                        ? raw.notification.bubbleKind
                        : undefined,
                    bubbleRole: raw.notification.bubbleRole === 'assistant' || raw.notification.bubbleRole === 'user'
                        ? raw.notification.bubbleRole
                        : (raw.notification.bubbleRole === 'system' ? 'system' : undefined),
                    bubbleSenderName: typeof raw.notification.bubbleSenderName === 'string'
                        ? raw.notification.bubbleSenderName
                        : undefined,
                },
            });
        }
    }

    return effects;
}

export function buildPersistedProviderEffectMessage(effect: ProviderEffect | null | undefined): ChatMessage | null {
    if (!effect) return null;

    if (effect.type === 'message' && effect.message) {
        const role = effect.message.role === 'assistant' || effect.message.role === 'user'
            ? effect.message.role
            : 'system';
        if (role === 'system') {
            return buildRuntimeSystemChatMessage({
                content: effect.message.content,
                kind: effect.message.kind,
                senderName: effect.message.senderName,
            });
        }
        return buildChatMessage({
            role,
            content: effect.message.content,
            kind: effect.message.kind,
            senderName: effect.message.senderName,
        } as ChatMessage);
    }

    if (effect.type === 'notification' && effect.notification) {
        const bubbleContent = effect.notification.bubbleContent
            ?? formatNotificationBubbleFallback(effect.notification.title, effect.notification.body);
        const flattened = typeof bubbleContent === 'string' ? bubbleContent.trim() : flattenContent(bubbleContent).trim();
        if (!flattened && (!Array.isArray(bubbleContent) || bubbleContent.length === 0)) return null;

        const role = effect.notification.bubbleRole === 'assistant' || effect.notification.bubbleRole === 'user'
            ? effect.notification.bubbleRole
            : 'system';
        if (role === 'system') {
            return buildRuntimeSystemChatMessage({
                content: bubbleContent,
                kind: effect.notification.bubbleKind,
                senderName: effect.notification.bubbleSenderName,
            });
        }
        return buildChatMessage({
            role,
            content: bubbleContent,
            kind: effect.notification.bubbleKind,
            senderName: effect.notification.bubbleSenderName,
        } as ChatMessage);
    }

    if (effect.type === 'toast' && effect.toast?.message) {
        return buildRuntimeSystemChatMessage({ content: effect.toast.message });
    }

    return null;
}

export function normalizeControlListResult(data: any): ControlListResult {
    if (!data || typeof data !== 'object' || !Array.isArray(data.options)) {
        throw new Error('Provider control list results must use the typed shape { options, currentValue?, error? }');
    }
    return {
        options: normalizeControlOptions(data.options),
        ...(isScalarControlValue(data.currentValue) ? { currentValue: data.currentValue } : {}),
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
    };
}

export function normalizeControlSetResult(data: any): ControlSetResult {
    if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
        throw new Error('Provider control set results must use the typed shape { ok, currentValue?, effects?, error? }');
    }
    const currentValue = isScalarControlValue(data.currentValue)
        ? data.currentValue
        : (isScalarControlValue(data.value) ? data.value : undefined);
    return {
        ok: data.ok,
        ...(currentValue !== undefined ? { currentValue } : {}),
        ...(Array.isArray(data.effects) ? { effects: normalizeProviderEffects(data) } : {}),
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
    };
}

export function normalizeControlInvokeResult(data: any): ControlInvokeResult {
    if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
        throw new Error('Provider control invoke results must use the typed shape { ok, currentValue?, effects?, error? }');
    }
    const currentValue = isScalarControlValue(data.currentValue)
        ? data.currentValue
        : (isScalarControlValue(data.value) ? data.value : undefined);
    return {
        ok: data.ok,
        ...(currentValue !== undefined ? { currentValue } : {}),
        ...(Array.isArray(data.effects) ? { effects: normalizeProviderEffects(data) } : {}),
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
    };
}

function normalizeControlOptions(options: unknown[]): ProviderControlOption[] {
    return options
        .map((option) => normalizeControlOption(option))
        .filter((option): option is ProviderControlOption => !!option);
}

function normalizeControlOption(option: unknown): ProviderControlOption | null {
    if (typeof option === 'string') {
        return { value: option, label: option };
    }
    if (!option || typeof option !== 'object') return null;
    const record = option as Record<string, unknown>;
    const value = typeof record.value === 'string'
        ? record.value
        : (typeof record.id === 'string'
            ? record.id
            : (typeof record.name === 'string' ? record.name : null));
    if (!value) return null;
    const label = typeof record.label === 'string'
        ? record.label
        : (typeof record.name === 'string' ? record.name : value);
    const normalized: ProviderControlOption = { value, label };
    if (typeof record.description === 'string') normalized.description = record.description;
    if (typeof record.group === 'string') normalized.group = record.group;
    return normalized;
}

function isScalarControlValue(value: unknown): value is ProviderControlValue {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function normalizeControlValue(value: any): ProviderControlValue {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (value && typeof value === 'object') {
        if (typeof value.label === 'string') return value.label;
        if (typeof value.name === 'string') return value.name;
        if (typeof value.id === 'string') return value.id;
    }
    return String(value);
}

function formatNotificationBubbleFallback(title: string | undefined, body: string): string {
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    const cleanBody = String(body || '').trim();
    if (cleanTitle && cleanBody) return `${cleanTitle}\n${cleanBody}`;
    return cleanTitle || cleanBody;
}
