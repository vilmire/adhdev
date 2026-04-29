import type { NativeHistoryAdapter, NativeHistoryFormat } from './types.js';
import { hermesNativeHistoryAdapter } from './hermes.js';
import { claudeNativeHistoryAdapter } from './claude.js';
import { codexNativeHistoryAdapter } from './codex.js';

const adapters: Record<NativeHistoryFormat, NativeHistoryAdapter> = {
    'hermes-json': hermesNativeHistoryAdapter,
    'claude-jsonl': claudeNativeHistoryAdapter,
    'codex-jsonl': codexNativeHistoryAdapter,
};

export function getNativeHistoryAdapter(format: NativeHistoryFormat | undefined): NativeHistoryAdapter | null {
    if (!format) return null;
    return adapters[format] || null;
}

export function listNativeHistoryAdapters(): NativeHistoryAdapter[] {
    return Object.values(adapters);
}
