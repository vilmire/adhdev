import { describe, expect, it } from 'vitest';
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js';
import type { ProviderModule } from '../../src/providers/contracts.js';

const provider: ProviderModule = {
    type: 'codex-cli',
    name: 'Codex CLI',
    category: 'cli',
    enabled: true,
    command: 'codex',
    args: [],
} as any;

describe('CliProviderInstance active chat identity', () => {
    it('uses exact runtime/provider identity instead of provider+workspace for same-workspace CLI sessions', () => {
        const first = new CliProviderInstance(provider, '/workspaces/shared', [], 'runtime-session-1', undefined, {
            providerSessionId: 'provider-session-1',
        });
        const second = new CliProviderInstance(provider, '/workspaces/shared', [], 'runtime-session-2', undefined, {
            providerSessionId: 'provider-session-2',
        });

        const firstState = first.getState();
        const secondState = second.getState();

        expect(firstState.activeChat?.id).toBe('provider-session-1');
        expect(secondState.activeChat?.id).toBe('provider-session-2');
        expect(firstState.activeChat?.id).not.toBe(secondState.activeChat?.id);
        expect(firstState.activeChat?.id).not.toBe('codex-cli_/workspaces/shared');
    });

    it('falls back to runtime instance id before workspace identity when provider session is not known yet', () => {
        const first = new CliProviderInstance(provider, '/workspaces/shared', [], 'runtime-session-1');
        const second = new CliProviderInstance(provider, '/workspaces/shared', [], 'runtime-session-2');

        expect(first.getState().activeChat?.id).toBe('runtime-session-1');
        expect(second.getState().activeChat?.id).toBe('runtime-session-2');
    });

    it('does not use a generic adapter runtime id as the active chat identity', () => {
        const instance = new CliProviderInstance(provider, '/workspaces/shared', [], 'runtime-session-1');
        const adapter = (instance as any).adapter;
        adapter.getRuntimeMetadata = () => ({
            runtimeId: 'codex-cli',
            runtimeKey: 'codex-cli',
        });

        expect(instance.getState().activeChat?.id).toBe('runtime-session-1');
    });
});
