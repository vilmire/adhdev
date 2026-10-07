/**
 * chat-row-expansion — the ONE expand-state store for the chat list.
 *
 * Before the row model there were two: `expandedTexts` (a Set in the list, for
 * local folds) and `toolExpansions` (a Record in ChatPane, for fetched tool
 * bodies), keyed differently and toggled by three different buttons. Both
 * answer the same question — "is this row (or this card inside it) open, and
 * with what text" — so they are one record keyed by a stable expand key:
 *
 *   `${contextKey}\u0001${expandKey}`            the row body
 *   `${contextKey}\u0001${expandKey}#${index}`   one card of a multi-relay row
 *
 * `expandKey` is the tool BLOCK identity when the row has one
 * (`getToolExpandStateKey`), else the row's React key — so an open expansion
 * survives a tool bubble's content being rewritten as its result streams.
 *
 * Fetching stays with the host (it owns the daemon transport): the list asks
 * `fetchToolBlock(address)` and stores what comes back here.
 */

import { useCallback, useState } from 'react';
import type { ToolExpandAddress } from './chatMessageHelpers';

/**
 * (TOOL-EXPAND) Why the daemon declined to serve an expansion.
 *
 * Mirrors `ToolBlockExpandFailure` (daemon-core
 * `providers/spec/tool-block-expand.ts`) by name: a closed enum, content-safe
 * in the same sense as the `toolBlockRef` integers, carried on the P2P command
 * reply only. Declared structurally because web-core must not take a value
 * dependency on daemon-core; a drift shows up as an unrecognised reason, which
 * takes the generic branch.
 */
export type ToolExpandFailureReason =
    | 'unsupported_source'
    | 'source_unavailable'
    | 'source_changed'
    | 'block_not_found'
    | 'not_a_tool_block';

/**
 * (TOOL-EXPAND) A fetched expansion. `text` replaces the summary once the
 * daemon answers; `error` carries the typed refusal, which must be SHOWN — the
 * honest answer is "that output is gone", not an empty box. `source_changed`
 * means a reload can fetch it; every other reason means it cannot be fetched.
 */
export interface ToolExpandState {
    status: 'loading' | 'expanded' | 'error';
    text?: string;
    error?: ToolExpandFailureReason;
}

/** Host-side fetch of a truncated tool body (`expand_tool_block`). */
export type FetchToolBlock = (address: ToolExpandAddress) => Promise<ToolExpandState>;

interface ExpandEntry {
    /** Locally opened (fold toggled, or a relay card expanded). */
    open?: boolean;
    /** Remote fetch state for a truncated tool block. */
    remote?: ToolExpandState;
}

export interface RowExpansionBinding {
    isTextExpanded: boolean;
    onToggleTextExpanded: () => void;
    toolExpand?: ToolExpandState;
    onExpandToolBlock?: (address: ToolExpandAddress) => void;
    onCollapseToolBlock?: () => void;
    /** Open card indices, comma-joined — a string so the row memo can compare it. */
    openSegments: string;
    onToggleSegment: (index: number) => void;
}

const SEP = '\u0001';

export function useChatRowExpansion(contextKey: string, fetchToolBlock?: FetchToolBlock) {
    const [entries, setEntries] = useState<Record<string, ExpandEntry>>({});

    const toggle = useCallback((storeKey: string) => {
        setEntries((prev) => {
            const current = prev[storeKey];
            const next = { ...prev };
            // Closing also drops a fetched body — re-opening refetches, exactly
            // as the host-owned record behaved.
            if (current?.open || current?.remote?.status === 'expanded') delete next[storeKey];
            else next[storeKey] = { open: true };
            return next;
        });
    }, []);

    const collapse = useCallback((storeKey: string) => {
        setEntries((prev) => {
            if (!prev[storeKey]) return prev;
            const next = { ...prev };
            delete next[storeKey];
            return next;
        });
    }, []);

    const fetchRemote = useCallback((storeKey: string, address: ToolExpandAddress) => {
        if (!fetchToolBlock) return;
        setEntries((prev) => ({ ...prev, [storeKey]: { remote: { status: 'loading' } } }));
        fetchToolBlock(address)
            .catch((): ToolExpandState => ({ status: 'error' }))
            .then((state) => setEntries((prev) => ({ ...prev, [storeKey]: { remote: state } })));
    }, [fetchToolBlock]);

    /** Everything one row needs, from its expand key. */
    const bind = useCallback((expandKey: string): RowExpansionBinding => {
        const storeKey = `${contextKey}${SEP}${expandKey}`;
        const entry = entries[storeKey];
        const segmentPrefix = `${storeKey}#`;
        const open: number[] = [];
        for (const key of Object.keys(entries)) {
            if (key.startsWith(segmentPrefix) && entries[key]?.open) open.push(Number(key.slice(segmentPrefix.length)));
        }
        return {
            isTextExpanded: entry?.open === true,
            onToggleTextExpanded: () => toggle(storeKey),
            toolExpand: entry?.remote,
            onExpandToolBlock: fetchToolBlock ? (address) => fetchRemote(storeKey, address) : undefined,
            onCollapseToolBlock: fetchToolBlock ? () => collapse(storeKey) : undefined,
            openSegments: open.sort((a, b) => a - b).join(','),
            onToggleSegment: (index) => toggle(`${segmentPrefix}${index}`),
        };
    }, [collapse, contextKey, entries, fetchRemote, fetchToolBlock, toggle]);

    return bind;
}
