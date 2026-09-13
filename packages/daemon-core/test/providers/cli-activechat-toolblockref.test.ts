/**
 * (TOOL-EXPAND) toolBlockRef must survive the activeChat projection.
 *
 * The parser stamps a content-free `toolBlockRef` on truncated tool bubbles,
 * and the dashboard renders its ToolExpandControl only when that ref is present
 * on the message (web-core chatMessageBubbles.tsx — `const expandableRef =
 * message.toolBlockRef`). Between those two points the CLI provider projects
 * messages into `activeChat.messages` through explicit field-by-field remaps.
 * Those remaps were allow-lists that did not list `toolBlockRef`, so every
 * canonical-history-backed tool bubble reached the dashboard without its ref
 * and the expand control silently degraded to local truncation.
 *
 * Measured against a real daemon debug bundle at the time of the fix: the
 * parser output carried 31 refs while the projected activeChat tail carried 0,
 * with keys exactly [role, content, kind, receivedAt].
 *
 * These tests drive the REAL projection/persistence functions rather than
 * asserting on parser output — the earlier regression tests checked the parser
 * (which was already correct) and therefore could not catch this.
 *
 * NOTE these remaps are the DOWNSTREAM half of the fix. They can only carry what
 * they are handed, and the upstream native-history normalizer was dropping the
 * ref before it ever reached them — see
 * test/config/native-history-toolblockref-passthrough.test.ts, which drives the
 * real read path and is what made the live projection go from 0 refs to N.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIncrementalHistoryAppendMessages } from '../../src/providers/cli-provider-history-dedup.js';

const srcFile = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../src/providers/${relative}`, import.meta.url)), 'utf8');

const REF = { sourceMtimeMs: 1_757_779_541_442, recordIndex: 12, blockIndex: 3 };

/**
 * The canonical-history branch of `buildProviderState`
 * (cli-provider-state-projection.ts) — the hop that feeds activeChat.messages
 * when a session replays its persisted tail. Mirrored here because the real
 * call needs a fully-wired ProviderStateHost; the remap itself is the unit
 * under test and is kept character-identical to the source.
 */
function projectPersistedTailToActiveChat(
    messages: Array<Record<string, any>>,
): Array<Record<string, any>> {
    return messages.map((message) => ({
        role: message.role,
        content: message.content,
        kind: message.kind,
        senderName: message.senderName,
        receivedAt: message.receivedAt,
        ...(message.toolBlockRef ? { toolBlockRef: message.toolBlockRef } : {}),
    }));
}

describe('(TOOL-EXPAND) activeChat projection carries toolBlockRef', () => {
    it('keeps the ref on a truncated tool bubble replayed from persisted history', () => {
        const persisted = [
            { role: 'user', content: 'run the build', kind: 'standard', receivedAt: 1 },
            { role: 'assistant', content: '↘ (truncated output)', kind: 'tool', receivedAt: 2, toolBlockRef: REF },
        ];

        const projected = projectPersistedTailToActiveChat(persisted);
        const tool = projected.find((m) => m.kind === 'tool');

        expect(tool?.toolBlockRef).toEqual(REF);
    });

    it('does not invent an undefined toolBlockRef key on prose bubbles', () => {
        // A bare `toolBlockRef: message.toolBlockRef` would put the key on every
        // row. `expandableRef` is only truthiness-checked so it would still
        // render correctly, but the key would then ride every prose bubble
        // across the wire and into delivery signatures.
        const projected = projectPersistedTailToActiveChat([
            { role: 'assistant', content: 'done', kind: 'standard', receivedAt: 1 },
        ]);

        expect(Object.keys(projected[0])).not.toContain('toolBlockRef');
    });

    it('carries the ref across the full parser -> persist -> replay round trip', () => {
        // The persist remap and the replay remap are two distinct hops; a fix to
        // only one of them still loses the ref end to end.
        const parsed = [
            { role: 'assistant', content: '↘ (truncated output)', kind: 'tool', receivedAt: 2, toolBlockRef: REF },
        ];

        const persisted = parsed.map((message: any) => ({
            role: message.role,
            content: message.content,
            kind: typeof message.kind === 'string' ? message.kind : undefined,
            senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
            receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : message.timestamp,
            ...(message.toolBlockRef ? { toolBlockRef: message.toolBlockRef } : {}),
        }));
        expect(persisted[0].toolBlockRef).toEqual(REF);

        const replayed = projectPersistedTailToActiveChat(persisted);
        expect(replayed[0].toolBlockRef).toEqual(REF);
    });

    it('keeps the ref through the incremental history append diff', () => {
        // buildIncrementalHistoryAppendMessages returns the newly-added tail and
        // is typed on PersistableCliHistoryMessage — the type had to grow the
        // field or the ref would be dropped at the type boundary.
        const appended = buildIncrementalHistoryAppendMessages(
            [{ role: 'user', content: 'run the build' }],
            [
                { role: 'user', content: 'run the build' },
                { role: 'assistant', content: '↘ (truncated output)', kind: 'tool', toolBlockRef: REF },
            ],
        );

        expect(appended).toHaveLength(1);
        expect(appended[0].toolBlockRef).toEqual(REF);
    });

    /**
     * Source-shape guard. The round-trip tests above exercise a mirror of the
     * remaps, so they would stay green if someone deleted the field from the
     * real projection. These read the shipped source and fail when any of the
     * three remaps stops carrying the ref — that is what makes this suite go
     * red when the fix is reverted.
     */
    it('every activeChat/persistence remap in the real source carries toolBlockRef', () => {
        const projection = srcFile('cli-provider-state-projection.ts');
        const historySync = srcFile('cli-provider-history-sync.ts');
        const dedup = srcFile('cli-provider-history-dedup.ts');

        // The three remaps this guard was written against (hydration read,
        // activeChat projection, persisted tail) no longer keep three copies of
        // the field list — that duplication is exactly what let the ref be fixed
        // at one hop and stay missing at the next, three times over. They now
        // delegate to one canonical projection.
        //
        // So the guard checks the same property against the new shape: all three
        // call sites route through `projectCliChatMessage`, and that function
        // carries the ref by name. Splitting on `receivedAt:` (the old anchor)
        // would now silently match nothing, so the delegation count is asserted
        // explicitly instead.
        const delegations = projection.match(/projectCliChatMessage\(/g) ?? [];
        expect(delegations.length, 'both projections in cli-provider-state-projection.ts must delegate').toBe(2);
        expect(historySync).toContain('projectCliChatMessage(message)');

        // The canonical projection must itself carry the ref, or every
        // delegation above would be satisfied by an empty function.
        expect(dedup).toContain('export function projectCliChatMessage');
        expect(dedup).toContain('toolBlockRef: message.toolBlockRef');
        expect(dedup).toContain('toolBlockRef?:');
        expect(dedup).toMatch(/projectCliChatMessage[\s\S]*carryMessageRefs\(message\)/);
    });

    /**
     * The same three remaps must also carry the producer-minted bubble identity.
     * web-core keys chat bubbles off it, so dropping it forces an index-derived
     * React key that renumbers whenever the tail grows (remount flash) and cannot
     * address a single bubble for expand/collapse state. All three delegate to one
     * shared helper so the identity cannot survive one hop and die at the next.
     */
    it('every activeChat/persistence remap also carries the bubble identity', () => {
        const projection = srcFile('cli-provider-state-projection.ts');
        const historySync = srcFile('cli-provider-history-sync.ts');
        const dedup = srcFile('cli-provider-history-dedup.ts');

        // Same delegation chain as the ref guard above; here the assertion is on
        // the identity end of it.
        expect(projection).toContain('projectCliChatMessage(message');
        expect(historySync).toContain('projectCliChatMessage(message)');

        // The chain must bottom out in ONE definition of the identity set:
        //   projectCliChatMessage -> carryMessageRefs -> carryBubbleIdentity
        // Each link is asserted, so an intermediate that stops delegating (and
        // silently re-lists a stale subset of fields) fails here.
        expect(dedup).toContain('export function carryBubbleIdentity');
        expect(dedup).toContain('export function carryMessageRefs');
        expect(dedup).toMatch(/projectCliChatMessage[\s\S]*carryMessageRefs\(message\)/);
        expect(dedup).toMatch(/carryMessageRefs[\s\S]*carryBubbleIdentity\(message\)/);
    });

    /**
     * The shared helper itself: by NAME and only when present (no `undefined`
     * keys on bubbles that never carried identity), identifiers/ordinals only.
     */
    it('carryBubbleIdentity copies identity by name and omits what is absent', async () => {
        const { carryBubbleIdentity } = await import('../../src/providers/cli-provider-history-dedup.js');

        expect(carryBubbleIdentity({
            sequence: 4,
            _turnKey: 'turn:2',
            bubbleState: 'final',
            providerUnitKey: 'u4',
            bubbleId: 'b4',
        })).toEqual({
            sequence: 4,
            _turnKey: 'turn:2',
            bubbleState: 'final',
            providerUnitKey: 'u4',
            bubbleId: 'b4',
        });

        expect(Object.keys(carryBubbleIdentity({}))).toEqual([]);
        // A non-finite ordinal is not an identity — it must not ride the wire.
        expect(Object.keys(carryBubbleIdentity({ sequence: Number.NaN }))).toEqual([]);
    });

    it('carryMessageRefs carries the ref AND the identity, each only when present', async () => {
        const { carryMessageRefs } = await import('../../src/providers/cli-provider-history-dedup.js');

        expect(carryMessageRefs({ toolBlockRef: REF, bubbleId: 'b9', sequence: 9 })).toEqual({
            toolBlockRef: REF,
            bubbleId: 'b9',
            sequence: 9,
        });

        // A bubble with identity but no ref must not gain a `toolBlockRef` key —
        // the activeChat projection feeds these straight to the dashboard, where
        // an always-present undefined key is not the same as an absent one.
        expect(Object.keys(carryMessageRefs({ bubbleId: 'b9' }))).toEqual(['bubbleId']);
        // ...and a truncated tool bubble with no identity yet keeps just the ref.
        expect(Object.keys(carryMessageRefs({ toolBlockRef: REF }))).toEqual(['toolBlockRef']);
        expect(Object.keys(carryMessageRefs({}))).toEqual([]);
    });

    it('holds the content boundary — the ref is exactly three integers', () => {
        // toolBlockRef is allowed on the P2P/activeChat lane precisely because it
        // is content-free. A ref that grew a path or a text field would have to
        // be re-reviewed against the status/server boundary.
        const projected = projectPersistedTailToActiveChat([
            { role: 'assistant', content: 'x', kind: 'tool', toolBlockRef: { ...REF } },
        ]);

        expect(Object.keys(projected[0].toolBlockRef).sort())
            .toEqual(['blockIndex', 'recordIndex', 'sourceMtimeMs']);
        for (const value of Object.values(projected[0].toolBlockRef)) {
            expect(typeof value).toBe('number');
        }
    });
});
