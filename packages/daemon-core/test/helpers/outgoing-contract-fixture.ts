import { mergeConversationMessages } from '../../src/providers/cli-provider-transcript-merge.js';
import { handleOutgoingReceipts, handleSendChat } from '../../src/commands/chat-commands-write.js';
import { AssistantRegistry, setAssistantRegistryForTests } from '../../src/assistant/assistant-registry.js';
import { createAssistantServices, setAssistantServicesForTests } from '../../src/assistant/assistant-services.js';
import { assistantExecution } from '../../src/assistant/assistant-execution.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalAdapter } from '../../src/providers/spec/adapter.js';
import { SendSubmitEngine } from '../../src/providers/spec/send-submit-engine.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { OutgoingReceiptStore } from '../../src/sessions/outgoing-receipt-store.js';
import { buildCliStructuredInputPrompt } from '../../src/providers/cli-provider-input-prompt.js';
import { recordAcknowledgedUserInput } from '../../src/providers/cli-provider-runtime-messages.js';
import { encodeChatMessageHead, chatMessageFromWire } from '../../src/seqscribe/transcript-keyed-codec.js';

/** No real process, network, config, owner data or private image is involved. */
export function outgoingContractFixture(sessionId: string, confirmed = true) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-outgoing-contract-'));
    let status = 'generating';
    const writes: string[] = [], acknowledgments: Array<() => void> = [];
    const native: any = { pid: 123, ready: Promise.resolve(), onData() {}, onExit() {}, resize() {}, kill() {}, detach() {},
        write(text: string) { writes.push(text); return confirmed ? new Promise<void>(resolve => acknowledgments.push(resolve)) : undefined; } };
    const adapter = new TerminalAdapter({ binary: 'synthetic', cwd: directory, env: {}, envIsComplete: true,
        transportFactory: { spawn: () => native } } as any, {});
    adapter.start();
    const engine = new SendSubmitEngine({ adapter, spec: { send_message: { submit_key: '\r', delay_ms_before_submit: 0, delay_ms_per_char: 0, posix_bracketed_paste_for_images: true } },
        opts: {}, readySeenOnce: true, lastPtyDataAt: 0, currentStateId: 'synthetic', specTag: () => 'synthetic', currentStatus: () => status } as any);
    const host: any = { type: 'codex-cli', instanceId: sessionId, workingDir: directory, adapter: {},
        runtimeMessages: [], recentUserInputAcks: new Map(), historyWriter: { appendNewMessages() {} } };
    const target: any = { getStatus: () => ({ status }),
        buildBody: (input: any) => ({ text: buildCliStructuredInputPrompt(input, { materializeDir: path.join(directory, 'images') }), bracketedPaste: true }),
        sendMessage: async (text: string, opts: any) => {
            const out = engine.handleSendMessage(text, opts.bracketedPaste, opts.messageId);
            return out.status === 'queued' ? { status: 'queued', position: out.queueDepth } : { status: 'delivered' };
        },
        observeSendWrite: (id: string, observer: any) => engine.observeSendWrite(id, observer),
        hasQueuedSend: (id: string) => engine.hasQueuedSend(id),
        recordAcknowledgedUserInput: (input: any, id: string, receipt: any) => recordAcknowledgedUserInput(host, input, id, receipt) };
    const store = new OutgoingReceiptStore(path.join(directory, 'receipts'));
    let service = createSessionInputService({ resolveSession: id => id === sessionId ? target : null, receiptStore: store });
    let frame = 0;
    // All action ingress dependencies are synthetic and stored under this temp dir.
    const registry = new AssistantRegistry({ configDir: directory });
    registry.bindSession({ sessionId, cliType: 'claude-cli', workspace: directory, at: 1 });
    const services = createAssistantServices({ configDir: directory, listMeshes: () => [{ id: 'synthetic-mesh' } as any] });
    const runtime = { getState: () => ({ type: 'claude-cli', settings: { assistant: true } }) };
    const sessionAdapter = { getStatus: () => ({ status }) };
    const modal = { message: 'Synthetic permission?', buttons: ['Accept', 'Reject'] };
    let actionAvailable = false;
    const worker = { getState: () => ({ category: 'cli', settings: { meshNodeFor: 'synthetic-mesh' }, activeChat: { activeModal: modal } }) };
    const helper: any = { getProvider: () => ({ type: 'claude-cli', category: 'cli' }), getCliAdapter: () => sessionAdapter,
        currentSession: { sessionId, transport: 'pty' }, ctx: { sessionInput: service,
            adapters: new Map([[sessionId, sessionAdapter], ['synthetic-worker', { getStatus: () => ({ activeModal: actionAvailable ? modal : null }) }]]),
            sessionRegistry: { get: () => ({ transport: 'pty' }) },
            instanceManager: { getInstance: (id: string) => id === sessionId ? runtime : actionAvailable && id === 'synthetic-worker' ? worker : null } } };

    return {
        sessionId, directory, writes, engine, store,
        submit: (message: any) => service.submit(message),
        authorizeAction() {
            actionAvailable = true;
            assistantExecution.attest(sessionId, runtime, sessionAdapter, 'claude-cli',
                ['--strict-mcp-config', '--tools=Read,WebSearch,WebFetch'], 'enforced');
        },
        submitHandler(message: any) {
            setAssistantRegistryForTests(registry); setAssistantServicesForTests(services);
            helper.ctx.sessionInput = service;
            return handleSendChat(helper, { ...message, targetSessionId: sessionId, _commandSource: 'standalone' });
        },
        /** Read-only command path — never writes or renews owner consent. */
        receiptsHandler(messageIds: string[]) {
            helper.ctx.sessionInput = service;
            return handleOutgoingReceipts(helper, { targetSessionId: sessionId, messageIds, _commandSource: 'standalone' });
        },
        receipts: (ids: string[]) => service.getReceipts(sessionId, ids),
        drain() { status = 'idle'; engine.drainPendingSends(); },
        idle() { status = 'idle'; },
        acknowledgeOne() { acknowledgments.shift()?.(); },
        acknowledge() { for (const resolve of acknowledgments.splice(0)) resolve(); status = 'generating'; engine.drainPendingSends(); },
        restartService() { service = createSessionInputService({ resolveSession: () => target,
            receiptStore: new OutgoingReceiptStore(path.join(directory, 'receipts')) }); },
        wire(native = false) {
            // Exercise native dedup before encoding and real browser consumption.
            const messages = native ? mergeConversationMessages(host.runtimeMessages,
                host.runtimeMessages.map((row: any) => ({ role: row.message.role, content: row.message.content })))
                : host.runtimeMessages.map((row: any) => row.message);
            return messages.map((message: any) => ({ message })).map((row: any, i: number) => {
                const head = encodeChatMessageHead(row.message, { id: `synthetic-bubble-${i}`, ord: String(i).padStart(5, '0'), rev: ++frame,
                    epoch: 'synthetic-wire-epoch', frame, srcId: null, body: { text: row.message.content } } as any);
                return chatMessageFromWire(head, row.message.content);
            });
        },
        close() { engine.cancelTimers(); adapter.detach(); setAssistantRegistryForTests(null); setAssistantServicesForTests(null); },
    };
}
