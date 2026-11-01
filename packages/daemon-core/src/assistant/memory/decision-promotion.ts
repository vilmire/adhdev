/**
 * Owner decision → preference memory (docs/design/2026-11-01-assistant-memory.md §3.8).
 *
 * When the owner has answered the same KIND of decision the same way three times,
 * the assistant learns it as a preference in USER.md ("when asked X, the owner
 * picked Y") so it can lead with that option next time. Constraints, all tested:
 *
 *  - Only the owner's own option answers count: `by: 'owner'`, any `via` except
 *    `auto` (an auto-applied recommendation is not the owner's will), and only an
 *    option pick, never a free-text answer.
 *  - "Same kind" = the decision item's `dedupeKey` (the normalised question, or the
 *    coordinator's explicit key) — there is no structured type field and the
 *    decision schema is not extended. "Same way" = the same option id AND label.
 *  - The preference text is a template (no model call): a clipped type label, the
 *    clipped option label and the count. No question body, context, option detail
 *    or free text is copied. Both labels are coordinator-authored, so they are
 *    clipped, JSON-quoted and still pass through the store's credential / injection
 *    / hidden-character checks like any write.
 *  - A preference only shapes which option the assistant recommends. Nothing here
 *    (or anywhere) reads it to answer a decision: `auto_recommended` application
 *    never consults memory (D4; pinned by a source-shape test).
 *  - Changing or undoing a supporting answer retracts the preference once fewer than
 *    three still back it (an undo through the memory journal, visible in the digest;
 *    while three still back it, the preference is re-pointed at another decision). A preference the
 *    OWNER undid from the digest is remembered as rejected and never promoted again.
 *  - Promotion is always journaled (`origin: decision_promotion`) and undoable.
 *    The USER budget being full falls back to the archive tier.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import { deriveItemDedupeKey, normalizeForDedupe, type MissionDecision } from '@adhdev/mesh-shared';
import type { DecisionAnsweredEvent } from '../../mesh/mesh-mission-decision-answer-notifier.js';
import type { AssistantMemoryStore, MemoryChangeEvent } from './memory-store.js';
import { firstChars } from './memory-content.js';

/** Same choice this many times (across decisions of one kind) becomes a preference. */
export const PROMOTION_THRESHOLD = 3;
export const PROMOTION_TYPE_LABEL_CHARS = 48;
export const PROMOTION_CHOICE_LABEL_CHARS = 60;

export interface PromotionItem {
    dedupeKey?: string;
    decision?: MissionDecision;
    state: string;
}

export interface DecisionPromotionPorts {
    readItem(meshId: string, itemId: string): PromotionItem | null;
}

interface LogRow { mesh_id: string; item_id: string; type_key: string; choice_key: string; choice_label: string }

export const sourceRefOf = (meshId: string, itemId: string): string => `decision:${meshId}:${itemId}`;

/** The decision's kind: its dedupe key, derived from the question when the record has none. */
export function decisionTypeKey(item: PromotionItem): string {
    return item.dedupeKey?.trim() || deriveItemDedupeKey('decision', { question: item.decision?.question ?? '' });
}

/** A short, human label for a kind: the key text without its `decision:` / `k:` prefix, clipped. */
export function typeLabel(typeKey: string): string {
    const bare = typeKey.replace(/^(?:decision|k):/, '');
    return firstChars(bare.replace(/\s+/g, ' ').trim(), PROMOTION_TYPE_LABEL_CHARS);
}

function oneLine(s: string, max: number): string {
    // eslint-disable-next-line no-control-regex
    return firstChars(s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
}

export function promotionText(typeKey: string, choiceLabel: string, count: number): string {
    return `When asked about ${JSON.stringify(typeLabel(typeKey))}, the owner chose ${JSON.stringify(oneLine(choiceLabel, PROMOTION_CHOICE_LABEL_CHARS))} (${count} decisions). Offer it as the default suggestion; it is never the owner's answer.`;
}

export class DecisionPromoter {
    private unlinking = false;
    private offStore: (() => void) | null = null;

    constructor(
        private readonly db: DatabaseHandle,
        private readonly memory: AssistantMemoryStore,
        private readonly ports: DecisionPromotionPorts,
        private readonly now: () => number = Date.now,
    ) {}

    /** Watch the memory store for the OWNER undoing a promoted preference (→ never promote it again). */
    start(): () => void {
        this.offStore?.();
        this.offStore = this.memory.onChange((e) => this.onMemoryChange(e));
        return () => { this.offStore?.(); this.offStore = null; };
    }

    private onMemoryChange(e: MemoryChangeEvent): void {
        if (this.unlinking || !e.reverted || e.origin !== 'owner' || e.action !== 'remove') return;
        const row = this.db.prepare("SELECT type_key, choice_key FROM assistant_decision_promotion WHERE state='promoted' AND text=?").get(e.text) as { type_key: string; choice_key: string } | undefined;
        if (row) this.db.prepare("UPDATE assistant_decision_promotion SET state='rejected' WHERE type_key=? AND choice_key=?").run(row.type_key, row.choice_key);
    }

    onAnswer(ev: DecisionAnsweredEvent): void {
        const ref = sourceRefOf(ev.meshId, ev.itemId);
        const prev = this.db.prepare('SELECT type_key, choice_key FROM assistant_decision_answer_log WHERE mesh_id=? AND item_id=?').get(ev.meshId, ev.itemId) as { type_key: string; choice_key: string } | undefined;
        if (ev.action === 'undone') {
            this.db.prepare('DELETE FROM assistant_decision_answer_log WHERE mesh_id=? AND item_id=?').run(ev.meshId, ev.itemId);
            if (prev) this.supportLost(prev.type_key, prev.choice_key, ref);
            return;
        }
        const item = this.ports.readItem(ev.meshId, ev.itemId);
        const counted = ev.by === 'owner' && ev.via !== 'auto' && !!ev.optionId && !!item?.decision;
        const label = counted ? item!.decision!.options.find((o) => o.id === ev.optionId)?.label ?? '' : '';
        if (!counted || !label) {
            // A change to a free-text / auto answer no longer supports what it used to.
            this.db.prepare('DELETE FROM assistant_decision_answer_log WHERE mesh_id=? AND item_id=?').run(ev.meshId, ev.itemId);
            if (prev) this.supportLost(prev.type_key, prev.choice_key, ref);
            return;
        }
        const typeKey = decisionTypeKey(item!);
        const choiceKey = `${ev.optionId}:${normalizeForDedupe(label)}`;
        this.db.prepare(`INSERT INTO assistant_decision_answer_log(mesh_id,item_id,type_key,choice_key,choice_label,answered_at,revision)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(mesh_id,item_id) DO UPDATE SET type_key=excluded.type_key, choice_key=excluded.choice_key,
            choice_label=excluded.choice_label, answered_at=excluded.answered_at, revision=excluded.revision`)
            .run(ev.meshId, ev.itemId, typeKey, choiceKey, label, this.now(), ev.revision);
        if (prev && (prev.type_key !== typeKey || prev.choice_key !== choiceKey)) this.supportLost(prev.type_key, prev.choice_key, ref);
        this.maybePromote(typeKey, choiceKey, label, ref);
    }

    private count(typeKey: string, choiceKey: string): number {
        return Number((this.db.prepare('SELECT COUNT(*) AS n FROM assistant_decision_answer_log WHERE type_key=? AND choice_key=?').get(typeKey, choiceKey) as { n: number }).n);
    }

    private maybePromote(typeKey: string, choiceKey: string, label: string, ref: string): void {
        const n = this.count(typeKey, choiceKey);
        if (n < PROMOTION_THRESHOLD) return;
        const existing = this.db.prepare('SELECT state FROM assistant_decision_promotion WHERE type_key=? AND choice_key=?').get(typeKey, choiceKey) as { state: string } | undefined;
        if (existing) return; // already promoted, or the owner said no
        const text = promotionText(typeKey, label, n);
        let out = this.memory.apply({ action: 'add', target: 'user', content: text, sourceRef: ref }, 'decision_promotion');
        if (out.result === 'memory_budget_exceeded') {
            out = this.memory.apply({ action: 'add', target: 'user', content: text, scope: 'archive', sourceRef: ref }, 'decision_promotion');
        }
        // A duplicate means it is already remembered; a refusal (content scan, store unreadable) leaves it to a later answer.
        if (out.result !== 'applied' && out.result !== 'memory_duplicate') return;
        this.db.prepare("INSERT INTO assistant_decision_promotion(type_key,choice_key,state,text,source_ref,at) VALUES (?,?,'promoted',?,?,?)")
            .run(typeKey, choiceKey, text, ref, this.now());
        try { this.memory.archive?.bump('decision_promoted'); } catch { /* metrics never block */ }
    }

    /**
     * An answer that supported (type, choice) was undone or changed. If the
     * choice is promoted and fewer than the threshold still back it, take the
     * preference back; if it is still backed but this decision was the one the
     * promotion pointed at, re-point it at another supporter.
     */
    private supportLost(typeKey: string, choiceKey: string, lostRef: string): void {
        const promo = this.db.prepare("SELECT source_ref FROM assistant_decision_promotion WHERE state='promoted' AND type_key=? AND choice_key=?").get(typeKey, choiceKey) as { source_ref: string } | undefined;
        if (!promo) return;
        const stillBacked = this.count(typeKey, choiceKey) >= PROMOTION_THRESHOLD;
        if (stillBacked && promo.source_ref !== lostRef) return;
        this.retract(promo.source_ref, typeKey, choiceKey);
        if (stillBacked) {
            const next = this.db.prepare('SELECT mesh_id, item_id, choice_label FROM assistant_decision_answer_log WHERE type_key=? AND choice_key=? ORDER BY answered_at DESC LIMIT 1').get(typeKey, choiceKey) as { mesh_id: string; item_id: string; choice_label: string } | undefined;
            if (next) this.maybePromote(typeKey, choiceKey, next.choice_label, sourceRefOf(next.mesh_id, next.item_id));
        }
    }

    /** Undo the preference(s) a promotion wrote (owner-visible, journaled) and forget the promotion. */
    private retract(ref: string, typeKey: string, choiceKey: string): void {
        this.unlinking = true;
        try {
            for (const rec of this.memory.readJournal()) {
                if (rec.origin !== 'decision_promotion' || rec.result !== 'applied' || rec.sourceRef !== ref) continue;
                this.memory.undo({ id: rec.jid ?? rec.ts });
            }
        } finally {
            this.unlinking = false;
        }
        this.db.prepare('DELETE FROM assistant_decision_promotion WHERE type_key=? AND choice_key=?').run(typeKey, choiceKey);
        try { this.memory.archive?.bump('decision_retracted'); } catch { /* metrics never block */ }
    }

    /** Test / diagnostics: rows currently supporting a (type, choice). */
    supportCount(typeKey: string, choiceKey: string): number {
        return this.count(typeKey, choiceKey);
    }
}

export type { LogRow as DecisionAnswerLogRow };
