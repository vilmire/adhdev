import { afterEach, expect, it } from 'vitest';
import { outgoingContractFixture } from '../helpers/outgoing-contract-fixture.js';
import { OutgoingReceiptStore } from '../../src/sessions/outgoing-receipt-store.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { outgoingInputDigest } from '../../src/seqscribe/outgoing-receipt.js';
const fixtures: ReturnType<typeof outgoingContractFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const input = { parts: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8T8AAAAASUVORK5CYII=' }, { type: 'text', text: 'Public example' }], textFallback: 'Public example' };
const message = { messageId: 'synthetic-msg', sessionId: 'synthetic-session', input, origin: 'dashboard', policy: { mode: 'queue' }, createdAt: 1 } as any;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it('journals acceptance before write, settles only after both acknowledged native writes, replays after restart without sending again', async () => {
    const f = outgoingContractFixture(message.sessionId);fixtures.push(f);
    expect((await f.submit(message)).kind).toBe('queued');
    const accepted = f.receipts([message.messageId])[0];
    expect(accepted.state).toBe('accepted');expect(f.writes).toHaveLength(0);
    expect(f.wire()[0].sourceMessageId).toBe(message.messageId);
    expect(f.wire()[0].runtimeInputAck).toBe(true);
    expect(f.wire()[0].outgoingReceipt?.state).toBe('accepted');
    f.drain();await expect.poll(() => f.writes.length).toBe(2);
    expect(f.writes).toHaveLength(2);expect(f.receipts([message.messageId])[0].state).toBe('uncertain');
    f.acknowledgeOne();await sleep(0);
    expect(f.receipts([message.messageId])[0].state).toBe('uncertain');
    f.acknowledge();await sleep(0);
    const submitted = f.receipts([message.messageId])[0];
    expect(submitted.state).toBe('submitted');expect(submitted.proof).toBe('native_write_ack');
    expect(submitted.attemptId).toBe(accepted.attemptId);expect(submitted.generation).toBe(accepted.generation);
    expect(f.wire()[0].outgoingReceipt?.state).toBe('submitted');
    f.restartService();expect((await f.submit(message)).kind).toBe('duplicate');expect(f.writes).toHaveLength(2);
    expect(f.receipts([message.messageId])[0]).toEqual(submitted);
    expect(f.store.list('foreign-session', [message.messageId])).toEqual([]);
});
it('immediate send is not proven by delivered disposition; a void backend remains uncertain without retrying after restart', async () => {
    const f = outgoingContractFixture(message.sessionId, false);fixtures.push(f);f.idle();
    expect((await f.submit(message)).kind).toBe('delivered');await expect.poll(() => f.writes.length).toBe(2);
    expect(f.receipts([message.messageId])[0].state).toBe('uncertain');
    f.restartService();expect((await f.submit(message)).kind).toBe('duplicate');expect(f.writes).toHaveLength(2);
});
it('rejects changed image/full-input identity and foreign generation, and atomically dedupes separate stores', () => {
    const f = outgoingContractFixture(message.sessionId);fixtures.push(f);
    const first = f.store.accept(message.messageId, message.sessionId, input);
    const second = new OutgoingReceiptStore(f.directory + '/receipts');
    expect(second.accept(message.messageId, message.sessionId, input).fresh).toBe(false);
    expect(() => second.accept(message.messageId, message.sessionId, { ...input, parts: [{ type: 'image', data: 'DIFFERENT' }] })).toThrow('identity conflict');
    expect(f.store.advance({ ...first.receipt, generation: 'foreign' }, 'submitted')).toBeUndefined();
    expect(outgoingInputDigest({ textFallback: input.textFallback, parts: input.parts })).toBe(outgoingInputDigest(input));
});

it('does not resurrect accepted certainty or resend an unacknowledged attempt after service restart', async () => {
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f);
    await f.submit(message);
    f.restartService();
    expect(f.receipts([message.messageId])[0].state).toBe('uncertain');
    expect((await f.submit(message)).kind).toBe('duplicate');
    expect(f.receipts([message.messageId])[0].state).toBe('uncertain');
    expect(f.writes).toHaveLength(0);
});

it('binds late native acknowledgments to the captured observer instead of a replacement observer', async () => {
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f);
    await f.submit(message); f.drain(); await expect.poll(() => f.writes.length).toBe(2);
    const foreign: string[] = [];
    f.engine.observeSendWrite(message.messageId, state => foreign.push(state));
    f.acknowledge(); await sleep(0);
    expect(f.receipts([message.messageId])[0].state).toBe('submitted');
    expect(foreign).toEqual([]);
});
it('records explicit pre-write failure durably and never replays that identity on retry', async () => {
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f);
    const service = createSessionInputService({ receiptStore: f.store, resolveSession: () => null });
    expect((await service.submit(message)).kind).toBe('refused');
    expect(service.getReceipts(message.sessionId, [message.messageId])[0]).toMatchObject({ state: 'failed', proof: 'not_written' });
    expect((await service.submit(message)).kind).toBe('duplicate');
    expect(f.writes).toHaveLength(0);
});

it.each([true, false])('real handler reserves original images before enrichment and replays without minting consent or writing twice (explicit text part: %s)', async hasTextPart => {
    const { assistantExecution } = await import('../../src/assistant/assistant-execution.js');
    const { vi } = await import('vitest');
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f); f.authorizeAction();
    const original = { ...input, textFallback: 'approve', parts: hasTextPart ? [{ type: 'text', text: 'approve' }, input.parts[0]] : [input.parts[0]] };
    const args = { ...message, input: original };
    const realIssue = assistantExecution.issue;
    const issue = vi.spyOn(assistantExecution, 'issue');
    issue.mockImplementation(function (...params) {
        expect(f.store.get(args.messageId)).toMatchObject({ state: 'accepted', inputDigest: outgoingInputDigest(original) });
        expect(f.writes).toHaveLength(0);
        return realIssue.apply(assistantExecution, params);
    });
    try {
        const [result, concurrentReplay] = await Promise.all([f.submitHandler(args), f.submitHandler(args)]);
        expect(concurrentReplay).toMatchObject({ deduplicated: true });
        expect(result).toMatchObject({ success: true, queued: true, outgoingReceipt: { inputDigest: outgoingInputDigest(original) } });
        expect(issue).toHaveBeenCalledTimes(1);
        expect(f.wire()[0].content).not.toContain('[ADHDev owner action]');
        expect(f.wire()[0].content).toContain('approve');
        expect(f.wire()[0].content).toContain('[image: image/png]');
        expect(await f.submitHandler(args)).toMatchObject({ deduplicated: true });
        expect(issue).toHaveBeenCalledTimes(1);
        f.drain(); await expect.poll(() => f.writes.length).toBe(2);
        expect(f.writes[0]).toContain('approve');
        expect(f.writes[0]).toContain('[ADHDev owner action]');
        expect(f.writes[0]).toContain('adhdev-input-image-');
        expect(f.receipts([args.messageId])[0].state).toBe('uncertain');
        f.acknowledge(); await sleep(0);
        const submitted = f.receipts([args.messageId])[0];
        expect(submitted).toMatchObject({ state: 'submitted', inputDigest: outgoingInputDigest(original) });
        expect(f.wire()[0].outgoingReceipt).toEqual(submitted);
        f.restartService();
        expect(await f.submitHandler(args)).toMatchObject({ deduplicated: true, outgoingReceipt: submitted });
        expect(await f.submitHandler({ ...args, input: { ...original, parts: [{ ...input.parts[0], data: 'different-image' }, original.parts[0]] } })).toMatchObject({ success: false });
        expect(await f.submitHandler({ ...args, input: { ...original, textFallback: 'reject', parts: [{ type: 'text', text: 'reject' }, input.parts[0]] } })).toMatchObject({ success: false });
        expect(issue).toHaveBeenCalledTimes(1); expect(f.writes).toHaveLength(2);
    } finally { issue.mockRestore(); }
});

it('real handler journals selection refusal as exact not_written, replays it after restart, and permits only fresh-ID retry', async () => {
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f);
    const args = { ...message, input: { ...input, textFallback: 'approve', parts: [{ type: 'text', text: 'approve' }, input.parts[0]] } };
    const refused = await f.submitHandler(args);
    expect(refused).toMatchObject({ success: false, code: 'assistant_action_needs_selection', sent: false,
        outgoingReceipt: { messageId: args.messageId, sessionId: args.sessionId, state: 'failed', proof: 'not_written', inputDigest: outgoingInputDigest(args.input) } });
    expect(f.writes).toHaveLength(0); expect(f.wire()).toEqual([]);
    f.restartService(); f.authorizeAction();
    expect(await f.submitHandler(args)).toMatchObject({ deduplicated: true, outgoingReceipt: refused.outgoingReceipt });
    expect(f.writes).toHaveLength(0);
    const retry = await f.submitHandler({ ...args, messageId: 'synthetic-fresh-retry' });
    expect(retry).toMatchObject({ success: true, queued: true, outgoingReceipt: { state: 'accepted' } });
    expect((retry.outgoingReceipt as any).attemptId).not.toBe((refused.outgoingReceipt as any).attemptId);
    f.drain(); await expect.poll(() => f.writes.length).toBe(2); f.acknowledge(); await sleep(0);
    expect(f.receipts(['synthetic-fresh-retry'])[0].state).toBe('submitted');
    expect(f.receipts([args.messageId])[0]).toEqual(refused.outgoingReceipt);
});

it('real send_chat carries exact original text/image acceptance through keyed codec without handled-turn authority', async () => {
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f);
    const result = await f.submitHandler(message);
    const receipt = f.receipts([message.messageId])[0];
    expect(result).toMatchObject({ success: true, queued: true, submitted: false, outgoingReceipt: receipt });
    expect(receipt).toMatchObject({ messageId: message.messageId, sessionId: message.sessionId,
        inputDigest: outgoingInputDigest(input), state: 'accepted', proof: 'acceptance' });
    expect(f.wire()[0]).toMatchObject({ sourceMessageId: message.messageId, runtimeInputAck: true, outgoingReceipt: receipt });
    expect(Object.keys(f.wire()[0].outgoingReceipt!).sort()).toEqual([
        'version', 'messageId', 'sessionId', 'attemptId', 'generation', 'inputDigest', 'state', 'revision', 'proof',
    ].sort());
    expect(f.writes).toHaveLength(0);
    expect(await f.submitHandler(message)).toMatchObject({ deduplicated: true, outgoingReceipt: receipt });
    expect(f.writes).toHaveLength(0);
});

it('outgoing_receipts command replays exact correlated receipts without writing or reseeding consent', async () => {
    const f = outgoingContractFixture(message.sessionId); fixtures.push(f);
    await f.submit(message);
    const accepted = f.receipts([message.messageId])[0];
    const beforeWrites = f.writes.length;
    expect(await f.receiptsHandler([message.messageId, 'foreign-id'])).toMatchObject({ success: true, receipts: [accepted] });
    expect(f.writes).toHaveLength(beforeWrites);
    expect(await f.submit(message)).toMatchObject({ kind: 'duplicate' });
    expect(f.writes).toHaveLength(beforeWrites);
    expect(await f.receiptsHandler([])).toMatchObject({ success: true, receipts: [] });
});

it.each(['queue_drain', 'queue_send_now', 'fresh_send_now', 'interrupt', 'idle_immediate'] as const)(
    'correlates native write acks to submitted receipt across route %s (and keeps void backend uncertain)',
    async route => {
        if (process.platform === 'win32' && (route === 'queue_send_now' || route === 'fresh_send_now')) return;
        const f = outgoingContractFixture(message.sessionId, true);
        fixtures.push(f);
        let initialReceipt: any;

        if (route === 'queue_drain') {
            expect((await f.submit(message)).kind).toBe('queued');
            initialReceipt = f.receipts([message.messageId])[0];
            f.drain();
        } else if (route === 'queue_send_now') {
            expect((await f.submit(message)).kind).toBe('queued');
            initialReceipt = f.receipts([message.messageId])[0];
            const out = await f.sendNow(message);
            expect(out).toMatchObject({ kind: 'delivered', route: 'agent_queue' });
        } else if (route === 'fresh_send_now') {
            const out = await f.sendNow(message);
            expect(out).toMatchObject({ kind: 'delivered', route: 'agent_queue' });
            initialReceipt = f.receipts([message.messageId])[0];
        } else if (route === 'interrupt') {
            const out = await f.submit({ ...message, policy: { mode: 'interrupt' } });
            expect(out).toMatchObject({ kind: 'delivered', route: 'interrupt' });
            initialReceipt = f.receipts([message.messageId])[0];
        } else {
            f.idle();
            const out = await f.submit(message);
            expect(out.kind).toBe('delivered');
            initialReceipt = f.receipts([message.messageId])[0];
        }

        await expect.poll(() => f.writes.length, { timeout: 2000 }).toBe(2);
        const uncertain = f.receipts([message.messageId])[0];
        expect(uncertain).toMatchObject({ state: 'uncertain', revision: 2, attemptId: initialReceipt.attemptId, generation: initialReceipt.generation });

        f.acknowledgeOne();
        await sleep(0);
        expect(f.receipts([message.messageId])[0].state).toBe('uncertain');

        f.acknowledge();
        await sleep(0);
        const submitted = f.receipts([message.messageId])[0];
        expect(submitted).toMatchObject({
            state: 'submitted',
            proof: 'native_write_ack',
            revision: 3,
            attemptId: initialReceipt.attemptId,
            generation: initialReceipt.generation,
        });
        expect(f.wire()[0].outgoingReceipt?.state).toBe('submitted');

        // Negative control: unconfirmed (void) backend stays uncertain on the same route
        const fVoid = outgoingContractFixture(`${message.sessionId}-void`, false);
        fixtures.push(fVoid);
        if (route === 'queue_drain') {
            await fVoid.submit({ ...message, sessionId: `${message.sessionId}-void` });
            fVoid.drain();
        } else if (route === 'queue_send_now') {
            await fVoid.submit({ ...message, sessionId: `${message.sessionId}-void` });
            await fVoid.sendNow({ ...message, sessionId: `${message.sessionId}-void` });
        } else if (route === 'fresh_send_now') {
            await fVoid.sendNow({ ...message, sessionId: `${message.sessionId}-void` });
        } else if (route === 'interrupt') {
            await fVoid.submit({ ...message, sessionId: `${message.sessionId}-void`, policy: { mode: 'interrupt' } });
        } else {
            fVoid.idle();
            await fVoid.submit({ ...message, sessionId: `${message.sessionId}-void` });
        }
        await expect.poll(() => fVoid.writes.length, { timeout: 2000 }).toBe(2);
        expect(fVoid.receipts([message.messageId])[0].state).toBe('uncertain');
    },
);

it('isolates concurrent ordinary attempt A from mid-generation send-now attempt B', async () => {
    if (process.platform === 'win32') return;
    const f = outgoingContractFixture(message.sessionId, true);
    fixtures.push(f);
    const msgA = { ...message, messageId: 'attempt-a' };
    const msgB = { ...message, messageId: 'attempt-b', input: { parts: [{ type: 'text', text: 'Follow up' }], textFallback: 'Follow up' } };

    // A drains on idle and writes 2 chunks (unacknowledged), then session enters generating
    f.idle();
    expect((await f.submit(msgA)).kind).toBe('delivered');
    await expect.poll(() => f.writes.length, { timeout: 2000 }).toBe(2);
    expect(f.receipts(['attempt-a'])[0].state).toBe('uncertain');

    // Flip status to generating while A's 2 native write acks are still pending, and send-now B
    f.generating();
    expect(await f.sendNow(msgB)).toMatchObject({ kind: 'delivered', route: 'agent_queue' });
    await expect.poll(() => f.writes.length, { timeout: 2000 }).toBe(4);
    expect(f.receipts(['attempt-a'])[0].state).toBe('uncertain');
    expect(f.receipts(['attempt-b'])[0].state).toBe('uncertain');

    // Acknowledge B's 2 writes (indices 2 and 3) first: B must become submitted while A stays uncertain
    const ackB1 = f.acknowledgments[2];
    const ackB2 = f.acknowledgments[3];
    ackB1();
    ackB2();
    await sleep(0);
    expect(f.receipts(['attempt-b'])[0].state).toBe('submitted');
    expect(f.receipts(['attempt-a'])[0].state).toBe('uncertain');

    // Now acknowledge A's 2 writes (indices 0 and 1): A advances to submitted
    f.acknowledgments[0]();
    f.acknowledgments[1]();
    await sleep(0);
    expect(f.receipts(['attempt-a'])[0].state).toBe('submitted');
});

it('pairs runtime user input acks with <pasted_content id="240c"> wrapped native transcript turns without duplicate bubbles', async () => {
    const { mergeConversationMessages } = await import('../../src/providers/cli-provider-transcript-merge.js');
    const { WRAPPED_TURN } = await import('../helpers/outgoing-contract-fixture.js');
    const body = 'Multi-line relay prompt:\nLine 2 of the prompt\nLine 3 of the prompt';
    const f = outgoingContractFixture(message.sessionId, true);
    fixtures.push(f);
    f.idle();
    const msg = {
        ...message,
        messageId: 'wrapped-turn-msg',
        input: { parts: [{ type: 'text', text: body }], textFallback: body },
    };
    await f.submit(msg);
    await expect.poll(() => f.writes.length, { timeout: 2000 }).toBe(2);
    f.acknowledge();
    await sleep(0);

    const merged = mergeConversationMessages(f.host.runtimeMessages, [
        { role: 'user', content: WRAPPED_TURN(body), timestamp: Date.now() },
        { role: 'assistant', content: 'Synthetic response', timestamp: Date.now() + 1 },
    ]);
    const userBubbles = merged.filter((m: any) => m.role === 'user');
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0].meta?.sourceMessageId).toBe('wrapped-turn-msg');
    expect(userBubbles[0].meta?.outgoingReceipt?.state).toBe('submitted');
});
