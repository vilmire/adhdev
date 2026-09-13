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

        // Each remap is anchored on `receivedAt`, the last field both of them
        // copied before the fix, so a rename of the ref alone cannot make this
        // pass vacuously. Both spellings of the surrounding remap (plain and
        // typeof-guarded) end on that field.
        const remaps = projection.split(/receivedAt: (?:message\.receivedAt|typeof message\.receivedAt)/);
        expect(remaps.length).toBe(3); // 2 remaps + head

        for (const [index, remap] of remaps.slice(1).entries()) {
            expect(
                remap.slice(0, 600),
                `cli-provider-state-projection.ts remap #${index + 1} dropped toolBlockRef`,
            ).toContain('toolBlockRef: message.toolBlockRef');
        }

        expect(historySync).toContain('toolBlockRef: message.toolBlockRef');
        expect(dedup).toContain('toolBlockRef?:');
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
