import { DaemonCommandRouter } from '../../src/commands/router.js';
import { createDaemonHostRuntime } from '../../src/boot/host-runtime.js';
import { createSessionLifecycleBus } from '../../src/sessions/lifecycle-bus.js';
import { SessionRegistry } from '../../src/sessions/registry.js';
import { SessionOutputFanout } from '../../src/boot/session-output-fanout.js';
import { applyInteractivePromptAnswer } from '../../src/providers/interactive-prompt-apply.js';
import type { CodexAppServerAdapter } from '../../src/providers/codex-app-server/adapter.js';

/** Real host and router; only provider discovery and transport output are inert. */
export function nativeQuestionHost(adapter: CodexAppServerAdapter, state?: () => any) {
    const bus = createSessionLifecycleBus();
    const sessionRegistry = new SessionRegistry(bus);
    const getState = state ?? (() => ({ instanceId: 'synthetic-session', activeInteractivePrompt: adapter.questions.active() }));
    const instance = { category: 'cli', getPresentationMode: () => 'chat', getState,
        applyInteractivePromptResponse: (data: unknown) => applyInteractivePromptAnswer({
            held: adapter.questions.active(), data, adapter, providerType: 'codex-cli' }),
    };
    const instanceManager = { getInstance: (id: string) => id === 'synthetic-session' ? instance : undefined,
        collectAllStates: () => [getState()], listInstanceIds: () => ['synthetic-session'] };
    const providerLoader = { watch() {}, getAll: () => [], resolve: () => null };
    const deps = { instanceManager, providerLoader, sessionRegistry, bus, cdpManagers: new Map(),
        cliManager: {}, detectedIdes: { value: [] }, commandHandler: { ctx: { gitCommandServices: {} } } };
    const router = new DaemonCommandRouter(deps as any);
    const components = { ...deps, router, outputFanout: new SessionOutputFanout() };
    const host = createDaemonHostRuntime({ components, bus, seqscribe: null } as any, {
        kind: 'standalone', instanceId: () => 'synthetic-daemon', version: 'test',
        topicSink: { send: () => true, isDeliverable: () => true, isAlive: () => true },
        broadcastSessionOutput() {}, sendStatusEvent() {}, onStatusFacts() {}, onMeshState() {}, onCommandExecuted() {},
    });
    return { host, router, instance, deps };
}
