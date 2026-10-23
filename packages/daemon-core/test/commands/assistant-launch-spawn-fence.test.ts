import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantLaunchFence, registerAssistantLaunchFence, retireAssistantLaunchFence } from '../../src/assistant/assistant-launch-fence.js';
import { startSession } from '../../src/commands/cli-manager-launch.js';
import { detectCLI } from '../../src/detection/cli-detector.js';

vi.mock('../../src/detection/cli-detector.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/detection/cli-detector.js')>(),
    detectCLI: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); });

it.each([false, true])('checks cancellation after delayed detection before spawning (managed: %s)', async managed => {
    const fence = new AssistantLaunchFence();
    const id = randomUUID();
    registerAssistantLaunchFence(id, fence);
    let finish!: (info: any) => void;
    vi.mocked(detectCLI).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const spawn = vi.fn(async () => {});
    const register = vi.fn(async () => {});
    const provider = managed ? { type: 'fixture-cli', category: 'cli', spawn: { command: 'fixture-cli' } } : undefined;
    const host: any = {
        providerLoader: { resolveAlias: (v: string) => v, getByAlias: () => provider,
            resolve: () => provider, isMachineProviderEnabled: () => true, getSettings: () => ({}) },
        deps: { getInstanceManager: () => managed ? {} : null, getP2p: () => null },
        createAdapter: () => ({ spawn }), registerCliInstance: register,
        readProviderChannel: () => 'stable', adapters: new Map(), roleRestartInputs: new Map(),
        persistRecentActivity: vi.fn(),
    };
    try {
        const pending = startSession(host, 'fixture-cli', tmpdir(), [], undefined, { presetSessionKey: id });
        const rejected = expect(pending).rejects.toThrow('assistant_launch_cancelled');
        expect(fence.cancelBeforeSpawn()).toBe(true);
        finish({ displayName: 'Fixture', version: '1.0' });
        await rejected;
        expect(spawn).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    } finally { retireAssistantLaunchFence(fence); }
});
