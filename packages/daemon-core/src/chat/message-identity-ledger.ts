/**
 * Per-session message identity ledger + aligner.
 *
 * Design: docs/design/2026-09-28-transcript-message-keyed-storage.md §3.3–§3.5.
 *
 * Every read_chat observation of a session passes through one ledger, which
 * gives each observed bubble a stable, opaque `messageId` and a fractional
 * order key `ord` (§4.4). The id never derives from content (D2):
 *
 *   `n.<L>.<addr>`   native, deterministic — from a reader-stamped `_src`
 *                    address (see `message-source-address.ts`).
 *   `d.<E>.<n>`      daemon-issued — for bubbles with no strong address (PTY
 *                    parse, IDE DOM, best-effort fallbacks) and for local
 *                    runtime/ACP rows. `E` is this ledger's epoch token.
 *
 * ── Assignment, per observation (one "frame") ──────────────────────────────
 *   1. Strong address first: a `_src` already bound in `bySrc` keeps its id.
 *   2. Aligner, over the unassigned new bubbles vs the unclaimed old entries
 *      (in `ord` order):
 *        a. exact (role, kind, text) anchors, order-preserving (common
 *           prefix/suffix trim, then LCS; patience anchors when the residual is
 *           too large for LCS);
 *        b. inside each gap between anchors, pair same-(role, kind) bubbles in
 *           order when the old text is a prefix of the new (streaming growth),
 *           equal modulo whitespace (PTY re-wrap), or close enough (prefix +
 *           suffix overlap ≥ 50% — a cheap stand-in for the design's edit-ratio
 *           ≤ 0.5);
 *        c. leftover exact matches across gaps (a bubble that MOVED);
 *        d. anything still unpaired: new → fresh id (natural `n.*` when it has
 *           a native address, else `d.*`; an exact match in the recent-tombstone
 *           pool is revived under its old id), old → tombstone, except under
 *           `coverage:'window'` where an old bubble ordered before the first
 *           surviving one scrolled out of view and is RETAINED (§3.5).
 *   3. `ord`: surviving bubbles whose `ord` still ascends in observation order
 *      (longest increasing subsequence) keep it; new and moved bubbles get keys
 *      between their neighbours, so only they change.
 *   4. `rev`: +1 whenever a bubble's revision key or `ord` changed. Re-observing
 *      an unchanged source changes nothing (idempotency).
 *
 * ── Handoff (§3.4) ─────────────────────────────────────────────────────────
 * A bubble that changes source keeps its id when the aligner pairs it with the
 * bubble it replaced in the same frame: runtime user echo → native user record,
 * PTY parse → native history (and back), screen scrape → native answer, and an
 * old lineage → a new one (resume/compact). The new strong address is bound to
 * the inherited id and reported as an alias (`srcId` = the natural id it would
 * otherwise have had). An old NATIVE entry is an aligner candidate only when the
 * new frame carries no native address of the same lineage — within a lineage,
 * native ids are exact and must never be inherited by a look-alike bubble.
 *
 * ── Boundaries ─────────────────────────────────────────────────────────────
 * Texts and revision keys are held for local alignment only (I3): nothing in
 * this module's output derives from content except through ids and integers.
 * The ledger is pure and in-memory; no I/O, no seqscribe. Lives in `chat/` so
 * the keyed seqscribe publisher can depend on it without crossing the
 * `seqscribe → providers|mesh` import boundary.
 *
 * OSS code (AGPL-3.0).
 */

import { randomBytes } from 'crypto';
import { generateNKeysBetween } from './fractional-index.js';
import {
    type MessageSourceAddress,
    messageSourceKey,
    naturalMessageId,
} from './message-source-address.js';

export type MessageIdentityCoverage = 'full' | 'window';

export interface MessageIdentityInput {
    readonly role: string;
    readonly kind: string;
    /** Flattened content. Local alignment only — never leaves the ledger. */
    readonly text: string;
    /** Reader-stamped strong address, when the source has one. */
    readonly src?: MessageSourceAddress;
    /**
     * Opaque presentation fingerprint; a change bumps `rev`. Local only. The
     * keyed publisher (design step 3) passes its wire-entry hash here.
     */
    readonly revisionKey: string;
}

export interface MessageIdentityAssignment {
    readonly messageId: string;
    readonly ord: string;
    readonly rev: number;
}

export interface MessageIdentityAlias {
    readonly messageId: string;
    /** The natural `n.*` id the new source would have had (§3.4 `srcId`). */
    readonly srcId: string;
}

export interface MessageIdentityFrame {
    /** Ledger epoch token `E` (also the `d.<E>.*` namespace). */
    readonly epoch: string;
    /** Monotonic per ledger. */
    readonly frame: number;
    /** Parallel to the observed inputs. */
    readonly assignments: readonly MessageIdentityAssignment[];
    /** Ids that are new, revived, or whose `rev` moved in this frame. */
    readonly upserts: readonly string[];
    /** Ids tombstoned in this frame. */
    readonly deletes: readonly string[];
    /** Source handoffs recorded in this frame. */
    readonly aliases: readonly MessageIdentityAlias[];
    /** Live entries kept although this observation did not include them (window coverage). */
    readonly retainedCount: number;
    /** True for the frame produced by {@link MessageIdentityLedger.reset}. */
    readonly reset: boolean;
}

export interface MessageIdentityObserveOptions {
    /**
     * `'window'` when the source only shows part of the transcript (IDE DOM
     * virtualization, a native tail read, a current-turn view): bubbles that
     * fell off the front are retained, not deleted. Default `'full'`.
     */
    readonly coverage?: MessageIdentityCoverage;
}

export interface MessageIdentityEntrySnapshot {
    readonly messageId: string;
    readonly ord: string;
    readonly rev: number;
    /** Latest strong address bound to this id, as a ledger source key. */
    readonly srcKey: string | null;
    /** Natural id of the adopted source when this id was inherited (§3.4). */
    readonly srcId: string | null;
    readonly retained: boolean;
}

interface LedgerEntry {
    readonly id: string;
    ord: string;
    rev: number;
    role: string;
    kind: string;
    text: string;
    revisionKey: string;
    /** Class/lineage of the latest bound strong address (null: aligner class). */
    srcClass: MessageSourceAddress['cls'] | null;
    lineage: string | null;
    srcKey: string | null;
    srcId: string | null;
    /** Every `bySrc` key that points here — cleared when the entry is finally evicted. */
    readonly boundKeys: Set<string>;
    retained: boolean;
}

/** Recently tombstoned entries kept for revival (caller-dependent filters, toggles). */
const TOMBSTONE_POOL_MAX = 256;
/** Upper bound on live entries; beyond it the oldest window-retained ones are tombstoned. */
const LIVE_ENTRIES_MAX = 10_000;
/** Residual middle size (old × new) up to which a full LCS table is used. */
const LCS_MAX_CELLS = 250_000;
/** §3.3 2b: minimum prefix+suffix overlap for "the same bubble, rewritten". */
const SIMILARITY_MIN_OVERLAP = 0.5;

function newEpochToken(): string {
    // 6 base36 chars (§3.2 `E`), drawn from 32 random bits.
    return randomBytes(4).readUInt32BE(0).toString(36).padStart(6, '0').slice(-6);
}

function contentKey(role: string, kind: string, text: string): string {
    return `${role}\u0000${kind}\u0000${text}`;
}

function sameContent(a: { role: string; kind: string; text: string }, b: { role: string; kind: string; text: string }): boolean {
    return a.role === b.role && a.kind === b.kind && a.text === b.text;
}

/**
 * §3.3 2b: is `next` a rewrite of `prev` (same bubble, content moved)? Only
 * called for bubbles of the same (role, kind) that sit in the same gap between
 * exact anchors, so the bar is deliberately permissive.
 */
function isRewriteOf(prev: string, next: string): boolean {
    const a = prev.replace(/\s+/g, '');
    const b = next.replace(/\s+/g, '');
    if (a === b) return true;
    // An empty placeholder that fills in, or a bubble cleared while streaming.
    if (!a || !b) return true;
    if (b.startsWith(a) || a.startsWith(b)) return true;
    const limit = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < limit && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    while (suffix < limit - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix += 1;
    return (prefix + suffix) / Math.max(a.length, b.length) >= SIMILARITY_MIN_OVERLAP;
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(values: readonly string[]): number[] {
    const tails: number[] = [];
    const prev: number[] = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i += 1) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[tails[mid]] < values[i]) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) prev[i] = tails[lo - 1];
        tails[lo] = i;
    }
    const out: number[] = [];
    let k = tails.length ? tails[tails.length - 1] : -1;
    while (k >= 0) {
        out.push(k);
        k = prev[k];
    }
    return out.reverse();
}

type AlignItem = { role: string; kind: string; text: string };

/**
 * Order-preserving exact anchors between `old` and `next` (pairs of indices,
 * both strictly ascending).
 */
function exactAnchors(old: readonly AlignItem[], next: readonly AlignItem[]): Array<[number, number]> {
    const anchors: Array<[number, number]> = [];
    let pre = 0;
    while (pre < old.length && pre < next.length && sameContent(old[pre], next[pre])) {
        anchors.push([pre, pre]);
        pre += 1;
    }
    let suf = 0;
    while (suf < old.length - pre && suf < next.length - pre
        && sameContent(old[old.length - 1 - suf], next[next.length - 1 - suf])) {
        suf += 1;
    }
    const oEnd = old.length - suf;
    const nEnd = next.length - suf;
    const oLen = oEnd - pre;
    const nLen = nEnd - pre;
    if (oLen > 0 && nLen > 0) {
        if (oLen * nLen <= LCS_MAX_CELLS) {
            // Classic LCS table over the residual middle.
            const width = nLen + 1;
            const table = new Int32Array((oLen + 1) * width);
            for (let i = oLen - 1; i >= 0; i -= 1) {
                for (let j = nLen - 1; j >= 0; j -= 1) {
                    table[i * width + j] = sameContent(old[pre + i], next[pre + j])
                        ? table[(i + 1) * width + j + 1] + 1
                        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
                }
            }
            let i = 0;
            let j = 0;
            while (i < oLen && j < nLen) {
                if (sameContent(old[pre + i], next[pre + j])) {
                    anchors.push([pre + i, pre + j]);
                    i += 1;
                    j += 1;
                } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
                    i += 1;
                } else {
                    j += 1;
                }
            }
        } else {
            // Patience anchors: keys unique on both sides, kept in order by LIS.
            const count = (items: readonly AlignItem[], from: number, to: number) => {
                const map = new Map<string, { n: number; at: number }>();
                for (let k = from; k < to; k += 1) {
                    const key = contentKey(items[k].role, items[k].kind, items[k].text);
                    const hit = map.get(key);
                    if (hit) hit.n += 1;
                    else map.set(key, { n: 1, at: k });
                }
                return map;
            };
            const oldKeys = count(old, pre, oEnd);
            const newKeys = count(next, pre, nEnd);
            const candidates: Array<[number, number]> = [];
            for (const [key, o] of oldKeys) {
                const n = newKeys.get(key);
                if (o.n === 1 && n && n.n === 1) candidates.push([o.at, n.at]);
            }
            candidates.sort((x, y) => x[1] - y[1]);
            const order = longestIncreasingSubsequence(candidates.map(([o]) => o.toString(36).padStart(8, '0')));
            for (const k of order) anchors.push(candidates[k]);
        }
    }
    for (let k = suf; k > 0; k -= 1) anchors.push([old.length - k, next.length - k]);
    return anchors;
}

/**
 * The aligner (§3.3 step 2): pairs of (old index, new index). Old and new are
 * each used at most once.
 */
export function alignMessageSequences(old: readonly AlignItem[], next: readonly AlignItem[]): Array<[number, number]> {
    const anchors = exactAnchors(old, next);
    const pairs: Array<[number, number]> = [...anchors];
    const oldUsed = new Uint8Array(old.length);
    const newUsed = new Uint8Array(next.length);
    for (const [o, n] of anchors) {
        oldUsed[o] = 1;
        newUsed[n] = 1;
    }
    // 2b — rewrites inside each gap between consecutive anchors.
    const bounds: Array<[number, number]> = [[-1, -1], ...anchors, [old.length, next.length]];
    for (let g = 0; g + 1 < bounds.length; g += 1) {
        const [oStart, nStart] = bounds[g];
        const [oStop, nStop] = bounds[g + 1];
        let cursor = oStart + 1;
        for (let n = nStart + 1; n < nStop; n += 1) {
            for (let o = cursor; o < oStop; o += 1) {
                if (oldUsed[o]) continue;
                if (old[o].role !== next[n].role || old[o].kind !== next[n].kind) continue;
                if (!isRewriteOf(old[o].text, next[n].text)) continue;
                pairs.push([o, n]);
                oldUsed[o] = 1;
                newUsed[n] = 1;
                cursor = o + 1;
                break;
            }
        }
    }
    // 2c — exact matches that crossed a gap: the bubble moved.
    const leftovers = new Map<string, number[]>();
    for (let o = 0; o < old.length; o += 1) {
        if (oldUsed[o]) continue;
        const key = contentKey(old[o].role, old[o].kind, old[o].text);
        const queue = leftovers.get(key);
        if (queue) queue.push(o);
        else leftovers.set(key, [o]);
    }
    for (let n = 0; n < next.length; n += 1) {
        if (newUsed[n]) continue;
        const queue = leftovers.get(contentKey(next[n].role, next[n].kind, next[n].text));
        const o = queue?.shift();
        if (o === undefined) continue;
        pairs.push([o, n]);
        oldUsed[o] = 1;
        newUsed[n] = 1;
    }
    return pairs;
}

export class MessageIdentityLedger {
    private epochToken: string;
    private counter = 0;
    private frameNo = 0;
    private readonly entries = new Map<string, LedgerEntry>();
    private readonly pool = new Map<string, LedgerEntry>();
    private readonly bySrc = new Map<string, string>();

    constructor(options: { epoch?: string } = {}) {
        this.epochToken = options.epoch || newEpochToken();
    }

    get epoch(): string {
        return this.epochToken;
    }

    get frame(): number {
        return this.frameNo;
    }

    /** Live entries (including window-retained), ascending `ord`. */
    snapshot(): MessageIdentityEntrySnapshot[] {
        return [...this.entries.values()]
            .sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0))
            .map((e) => ({
                messageId: e.id,
                ord: e.ord,
                rev: e.rev,
                srcKey: e.srcKey,
                srcId: e.srcId,
                retained: e.retained,
            }));
    }

    /**
     * verifiedClear (§3.5): tombstone every live bubble and start a new epoch.
     * Daemon-issued ids of the old epoch are never reissued.
     */
    reset(): MessageIdentityFrame {
        const deletes = [...this.entries.keys()];
        this.entries.clear();
        this.pool.clear();
        this.bySrc.clear();
        this.counter = 0;
        let next = newEpochToken();
        while (next === this.epochToken) next = newEpochToken();
        this.epochToken = next;
        this.frameNo += 1;
        return {
            epoch: this.epochToken,
            frame: this.frameNo,
            assignments: [],
            upserts: [],
            deletes,
            aliases: [],
            retainedCount: 0,
            reset: true,
        };
    }

    observe(inputs: readonly MessageIdentityInput[], options: MessageIdentityObserveOptions = {}): MessageIdentityFrame {
        const coverage: MessageIdentityCoverage = options.coverage === 'window' ? 'window' : 'full';
        this.frameNo += 1;
        const count = inputs.length;
        const ids: Array<string | null> = new Array(count).fill(null);
        const claimed = new Set<string>();
        const previouslyLive = new Set(this.entries.keys());
        const created = new Set<string>();
        const revived = new Set<string>();
        const aliases: MessageIdentityAlias[] = [];

        // Strong addresses, with an in-frame collision demoted to the aligner
        // class (§3.2: e.g. two DOM ids that normalize to the same token).
        const srcs: Array<MessageSourceAddress | undefined> = new Array(count).fill(undefined);
        const srcKeys: Array<string | null> = new Array(count).fill(null);
        {
            const seen = new Set<string>();
            for (let i = 0; i < count; i += 1) {
                const src = inputs[i].src;
                if (!src) continue;
                const key = messageSourceKey(src);
                if (seen.has(key)) continue;
                seen.add(key);
                srcs[i] = src;
                srcKeys[i] = key;
            }
        }

        // ── 1. strong address → known id ────────────────────────────────────
        for (let i = 0; i < count; i += 1) {
            const key = srcKeys[i];
            if (!key) continue;
            const id = this.bySrc.get(key);
            if (!id || claimed.has(id)) continue;
            if (this.entries.has(id)) {
                ids[i] = id;
                claimed.add(id);
            } else if (this.pool.has(id)) {
                this.revive(id);
                revived.add(id);
                ids[i] = id;
                claimed.add(id);
            }
        }

        // ── 2. aligner ──────────────────────────────────────────────────────
        const frameLineages = new Set<string>();
        for (const src of srcs) if (src?.cls === 'n') frameLineages.add(src.L);
        const oldCandidates = [...this.entries.values()]
            .filter((e) => !claimed.has(e.id) && !(e.srcClass === 'n' && e.lineage !== null && frameLineages.has(e.lineage)))
            .sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0));
        const newPositions: number[] = [];
        for (let i = 0; i < count; i += 1) if (ids[i] === null) newPositions.push(i);
        if (oldCandidates.length > 0 && newPositions.length > 0) {
            const pairs = alignMessageSequences(oldCandidates, newPositions.map((i) => inputs[i]));
            for (const [o, n] of pairs) {
                const entry = oldCandidates[o];
                const i = newPositions[n];
                ids[i] = entry.id;
                claimed.add(entry.id);
                const src = srcs[i];
                if (src) this.bind(entry, src, srcKeys[i]!, aliases);
            }
        }

        // ── 2d. unpaired new bubbles ────────────────────────────────────────
        for (let i = 0; i < count; i += 1) {
            if (ids[i] !== null) continue;
            const input = inputs[i];
            const src = srcs[i];
            if (!src) {
                const revivedId = this.findRevivable(input, claimed);
                if (revivedId) {
                    this.revive(revivedId);
                    revived.add(revivedId);
                    ids[i] = revivedId;
                    claimed.add(revivedId);
                    continue;
                }
            }
            const natural = src ? naturalMessageId(src) : null;
            let id: string;
            if (natural && !claimed.has(natural) && !this.entries.has(natural)) {
                // A natural id evicted from the pool is simply recreated.
                this.dropFromPool(natural);
                id = natural;
            } else {
                id = this.mint(claimed);
            }
            const entry: LedgerEntry = {
                id,
                ord: '',
                rev: 1,
                role: input.role,
                kind: input.kind,
                text: input.text,
                revisionKey: input.revisionKey,
                srcClass: null,
                lineage: null,
                srcKey: null,
                srcId: null,
                boundKeys: new Set(),
                retained: false,
            };
            this.entries.set(id, entry);
            if (src) this.bind(entry, src, srcKeys[i]!, natural === id ? null : aliases);
            created.add(id);
            ids[i] = id;
            claimed.add(id);
        }

        // ── unpaired old bubbles: tombstone, or retain under window coverage ─
        let minSurvivingOrd: string | null = null;
        for (const id of claimed) {
            if (!previouslyLive.has(id)) continue;
            const ord = this.entries.get(id)!.ord;
            if (minSurvivingOrd === null || ord < minSurvivingOrd) minSurvivingOrd = ord;
        }
        const deletes: string[] = [];
        for (const id of previouslyLive) {
            if (claimed.has(id)) continue;
            const entry = this.entries.get(id)!;
            if (coverage === 'window' && (minSurvivingOrd === null || entry.ord < minSurvivingOrd)) {
                entry.retained = true;
                continue;
            }
            this.tombstone(entry);
            deletes.push(id);
        }

        // ── 3. ord ──────────────────────────────────────────────────────────
        const list = ids as string[];
        const ordChanged = this.assignOrds(list, previouslyLive, claimed);

        // ── 4. rev ──────────────────────────────────────────────────────────
        const upserts: string[] = [];
        const assignments: MessageIdentityAssignment[] = new Array(count);
        for (let i = 0; i < count; i += 1) {
            const id = list[i];
            const entry = this.entries.get(id)!;
            const input = inputs[i];
            if (created.has(id)) {
                upserts.push(id);
            } else if (revived.has(id) || entry.revisionKey !== input.revisionKey || ordChanged.has(id)) {
                entry.rev += 1;
                upserts.push(id);
            }
            entry.role = input.role;
            entry.kind = input.kind;
            entry.text = input.text;
            entry.revisionKey = input.revisionKey;
            entry.retained = false;
            assignments[i] = { messageId: id, ord: entry.ord, rev: entry.rev };
        }

        deletes.push(...this.enforceLiveCap());
        let retainedCount = 0;
        for (const entry of this.entries.values()) if (entry.retained) retainedCount += 1;

        return {
            epoch: this.epochToken,
            frame: this.frameNo,
            assignments,
            upserts,
            deletes,
            aliases,
            retainedCount,
            reset: false,
        };
    }

    // ── internals ───────────────────────────────────────────────────────────

    private mint(claimed: ReadonlySet<string>): string {
        for (;;) {
            this.counter += 1;
            const id = `d.${this.epochToken}.${this.counter}`;
            if (!claimed.has(id) && !this.entries.has(id) && !this.pool.has(id)) return id;
        }
    }

    private bind(entry: LedgerEntry, src: MessageSourceAddress, key: string, aliases: MessageIdentityAlias[] | null): void {
        this.bySrc.set(key, entry.id);
        entry.boundKeys.add(key);
        entry.srcKey = key;
        entry.srcClass = src.cls;
        entry.lineage = src.cls === 'n' ? src.L : null;
        const natural = naturalMessageId(src);
        if (natural && natural !== entry.id) {
            entry.srcId = natural;
            aliases?.push({ messageId: entry.id, srcId: natural });
        }
    }

    private tombstone(entry: LedgerEntry): void {
        this.entries.delete(entry.id);
        entry.retained = false;
        this.pool.delete(entry.id);
        this.pool.set(entry.id, entry);
        while (this.pool.size > TOMBSTONE_POOL_MAX) {
            const oldest = this.pool.keys().next().value as string;
            this.dropFromPool(oldest);
        }
    }

    private dropFromPool(id: string): void {
        const entry = this.pool.get(id);
        if (!entry) return;
        this.pool.delete(id);
        for (const key of entry.boundKeys) {
            if (this.bySrc.get(key) === id) this.bySrc.delete(key);
        }
    }

    private revive(id: string): void {
        const entry = this.pool.get(id);
        if (!entry) return;
        this.pool.delete(id);
        this.entries.set(id, entry);
    }

    /** Newest exact tombstone for an unaddressed bubble (e.g. a filter toggled back). */
    private findRevivable(input: MessageIdentityInput, claimed: ReadonlySet<string>): string | null {
        const pooled = [...this.pool.values()];
        for (let k = pooled.length - 1; k >= 0; k -= 1) {
            const entry = pooled[k];
            if (claimed.has(entry.id)) continue;
            if (entry.srcClass === 'n') continue;
            if (sameContent(entry, input)) return entry.id;
        }
        return null;
    }

    /**
     * Step 3: keep the `ord` of surviving bubbles that are still in ascending
     * order, give every other listed bubble a key between its neighbours.
     * Returns the ids whose `ord` changed (moved or revived; new ids are
     * counted as created, not changed).
     */
    private assignOrds(list: readonly string[], previouslyLive: ReadonlySet<string>, claimed: ReadonlySet<string>): Set<string> {
        const changed = new Set<string>();
        const survivorPositions: number[] = [];
        for (let i = 0; i < list.length; i += 1) {
            if (previouslyLive.has(list[i]) && this.entries.get(list[i])!.ord) survivorPositions.push(i);
        }
        const keep = new Set<number>(
            longestIncreasingSubsequence(survivorPositions.map((i) => this.entries.get(list[i])!.ord))
                .map((k) => survivorPositions[k]),
        );
        // Window-retained bubbles all sort before the first survivor, so a run
        // with no kept left neighbour starts after the last of them.
        let maxRetainedOrd: string | null = null;
        for (const entry of this.entries.values()) {
            if (claimed.has(entry.id)) continue;
            if (maxRetainedOrd === null || entry.ord > maxRetainedOrd) maxRetainedOrd = entry.ord;
        }
        let i = 0;
        while (i < list.length) {
            if (keep.has(i)) {
                i += 1;
                continue;
            }
            let j = i;
            while (j < list.length && !keep.has(j)) j += 1;
            let lower = i > 0 ? this.entries.get(list[i - 1])!.ord : maxRetainedOrd;
            const upper = j < list.length ? this.entries.get(list[j])!.ord : null;
            if (lower !== null && upper !== null && lower >= upper) lower = null;
            const keys = generateNKeysBetween(lower || null, upper, j - i);
            for (let k = i; k < j; k += 1) {
                const entry = this.entries.get(list[k])!;
                const nextOrd = keys[k - i];
                if (entry.ord !== nextOrd) {
                    if (entry.ord) changed.add(entry.id);
                    entry.ord = nextOrd;
                }
            }
            i = j;
        }
        return changed;
    }

    private enforceLiveCap(): string[] {
        if (this.entries.size <= LIVE_ENTRIES_MAX) return [];
        const retained = [...this.entries.values()]
            .filter((e) => e.retained)
            .sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0));
        const dropped: string[] = [];
        for (const entry of retained) {
            if (this.entries.size <= LIVE_ENTRIES_MAX) break;
            this.tombstone(entry);
            dropped.push(entry.id);
        }
        return dropped;
    }
}

// ── Session registry ─────────────────────────────────────────────────────────

/**
 * Sessions whose ledgers are kept; least recently observed is dropped first.
 * A ledger holds its session's flattened bubble text for alignment, so this
 * bounds memory as much as it bounds the map. A dropped ledger only costs its
 * `d.*` ids (native `n.*` ids re-derive): the next read re-mints them once.
 */
const LEDGER_REGISTRY_MAX = 128;
const ledgers = new Map<string, MessageIdentityLedger>();

/** The session's ledger, created on first use (LRU-bounded). */
export function getMessageIdentityLedger(sessionKey: string): MessageIdentityLedger {
    let ledger = ledgers.get(sessionKey);
    if (ledger) {
        ledgers.delete(sessionKey);
    } else {
        ledger = new MessageIdentityLedger();
    }
    ledgers.set(sessionKey, ledger);
    while (ledgers.size > LEDGER_REGISTRY_MAX) {
        const oldest = ledgers.keys().next().value as string;
        ledgers.delete(oldest);
    }
    return ledger;
}

/** Peek without creating (tests, diagnostics, the step-3 publisher). */
export function peekMessageIdentityLedger(sessionKey: string): MessageIdentityLedger | undefined {
    return ledgers.get(sessionKey);
}

export function dropMessageIdentityLedger(sessionKey: string): void {
    ledgers.delete(sessionKey);
}

export function __resetMessageIdentityLedgersForTest(): void {
    ledgers.clear();
}
