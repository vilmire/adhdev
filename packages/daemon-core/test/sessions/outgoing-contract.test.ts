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
