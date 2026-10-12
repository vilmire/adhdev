/** Ephemeral provenance supplied by the owning daemon, never inferred from prompt text. */
export interface ProviderQuestionBinding {
    transport: 'codex_rpc' | 'codex_async';
    sessionId: string;
    generation: string;
    threadId: string;
    turnId: string;
    itemId: string;
    requestId?: string | number;
}

export type ProviderQuestionLifecycle = 'pending' | 'submitted' | 'resolved' | 'completed' | 'cancelled' | 'expired' | 'unknown';

export interface ProviderQuestionEpisode {
    blocking?: boolean;
    binding?: ProviderQuestionBinding;
    lifecycle?: ProviderQuestionLifecycle;
    /** Async dismiss is product-local; it is not a native tool cancellation. */
    support?: 'request_bound' | 'product_local' | 'uncertain';
}

export function isProviderQuestionBinding(value: unknown): value is ProviderQuestionBinding {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const b = value as Record<string, unknown>;
    if (b.transport !== 'codex_rpc' && b.transport !== 'codex_async') return false;
    const keys = ['transport', 'sessionId', 'generation', 'threadId', 'turnId', 'itemId', ...(b.transport === 'codex_rpc' ? ['requestId'] : [])];
    if (Reflect.ownKeys(b).some(key => typeof key !== 'string' || !keys.includes(key))) return false;
    if (['sessionId', 'generation', 'threadId', 'turnId', 'itemId'].some(key => typeof b[key] !== 'string' || !(b[key] as string).trim())) return false;
    return b.transport === 'codex_async' ? b.requestId === undefined
        : (typeof b.requestId === 'string' && !!b.requestId.trim()) || (typeof b.requestId === 'number' && Number.isFinite(b.requestId));
}
