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
    return {
        sessionId, directory, writes, engine, store,
        submit: (message: any) => service.submit(message),
        receipts: (ids: string[]) => service.getReceipts(sessionId, ids),
        drain() { status = 'idle'; engine.drainPendingSends(); },
        idle() { status = 'idle'; },
        acknowledgeOne() { acknowledgments.shift()?.(); },
        acknowledge() { for (const resolve of acknowledgments.splice(0)) resolve(); status = 'generating'; engine.drainPendingSends(); },
        restartService() { service = createSessionInputService({ resolveSession: () => target,
            receiptStore: new OutgoingReceiptStore(path.join(directory, 'receipts')) }); },
        wire() {
            return host.runtimeMessages.map((row: any, i: number) => {
                const head = encodeChatMessageHead(row.message, { id: `synthetic-bubble-${i}`, ord: String(i).padStart(5, '0'), rev: ++frame,
                    epoch: 'synthetic-wire-epoch', frame, srcId: null, body: { text: row.message.content } } as any);
                return chatMessageFromWire(head, row.message.content);
            });
        },
        close() { engine.cancelTimers(); adapter.detach(); },
    };
}
