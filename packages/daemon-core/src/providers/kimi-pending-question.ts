/**
 * kimi-pending-question — wire.jsonl authority for kimi's AskUserQuestion
 * picker (the InteractivePrompt / waiting_choice path, previously
 * claude-cli-only).
 *
 * kimi 0.34 renders AskUserQuestion as an interactive TUI picker (numbered
 * option rows, per-question tabs, a review screen) that the PTY modal/spinner
 * matchers do NOT classify — the session keeps reading 'generating' while it
 * sits parked waiting for an answer, so no waiting_choice status, no
 * agent:waiting_choice event, and mesh_answer_question had nothing to bind to
 * (the live coordinator-question blind spot).
 *
 * The durable signal is the session's own append-only native transcript
 * (`~/.kimi-code/sessions/<wdKey>/session_<uuid>/agents/main/wire.jsonl`),
 * re-read at status-poll time exactly like background-task-detector (whose
 * resolution + bounded tail-read this module reuses):
 *
 *   - pending:  context.append_loop_event / tool.call with
 *               name === 'AskUserQuestion' (toolCallId, args.questions[])
 *               and NO tool.result with the same toolCallId after it.
 *   - resolved: the matching tool.result — kimi writes it whether the answer
 *               came from the terminal or from an injected keystroke answer,
 *               so the held prompt clears on the next poll either way.
 *
 * promptId is the toolCallId: stable, unique per call, and it survives a
 * daemon restart (the same pending call re-read from disk yields the same id,
 * so a pre-restart answer still binds — the rc.20 rebind-fidelity rule the
 * claude TUI path solves with a content fingerprint).
 *
 * Illustrative kimi 0.34.0 wire.jsonl shape
 * (`~/.kimi-code/sessions/<wdKey>/session_<uuid>/agents/main/wire.jsonl`): the
 * tool.call event carries `toolCallId` / `name` / `args.questions[]` with
 * { header, question, options: [{ label, description }] }; the tool.result
 * event carries the same top-level `toolCallId`. Multi-select questions carry
 * `multi_select` (snake_case) in the question args; `multiSelect` is also
 * accepted defensively (no live capture of either — see tests).
 *
 * This module ALSO covers kimi's built-in idle/cache-expired selector
 * ("This session has been idle for Nm… / Cache expired — …" with rows like
 * "Compact and continue" / "Start a new session"). That picker is a TUI
 * built-in, NOT an AskUserQuestion tool call, so the wire never carries it
 * and the approval modal matchers never fire — a parked session read as
 * plain `idle` while the selector ate input (live defect, 2026-08-12). It is
 * detected from the live PTY screen (detectKimiIdleSelectorPrompt) and
 * answered with arrow keys (buildKimiSelectorAnswerSteps) — the selector
 * renders no numbered rows, so the digit protocol does not apply.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOG } from '../logging/logger.js';
import { resolveJsonlSourcePath, resolveJsonlSidecarSourceAsync, resolveJsonlSidecarSourceFromEvidence, type JsonlSourceResolution } from './spec/native-history-executor.js';
import type { NativeHistoryInput } from './spec/native-history-types.js';
import { readTailJsonlLines, readTailJsonlLinesAsync, detectFromRecords, type BackgroundTaskDetection } from './spec/background-task-detector.js';
import { canonicalSourcePathAsync, expandPath, sourceRevisionAsync, type SidecarSourceEvidence } from './spec/native-history-paths.js';
import { claimTranscript, transcriptClaimOwner, transcriptClaimOwnerToken } from './native-history/transcript-claim-registry.js';
import { sentPromptSnippets } from './native-history/sent-prompt-registry.js';
import type { InteractivePrompts } from './spec/fsm-types.js';
import type { NativeHistoryConfig } from './spec/types.js';
import {
    interactivePromptContentFingerprint,
    normalizeInteractivePrompt,
    type InteractivePrompt,
    type InteractivePromptResponse,
} from './types/interactive-prompt.js';

/**
 * Only the recent tail of the transcript is scanned, so a long session
 * doesn't re-read megabytes on every status poll. A pending AskUserQuestion
 * blocks the turn, so its tool.call is always near the write head; 512 KiB
 * (same bound as background-task-detector) covers it with wide margin.
 */
const TAIL_BYTES = 512 * 1024;

/**
 * Detect whether the session's own wire.jsonl shows an UNANSWERED
 * AskUserQuestion tool call, and if so build the InteractivePrompt for it.
 *
 * Returns null for every non-kimi provider, on any resolution/read/parse
 * failure (fail-open: a transient read error must never wedge a held prompt
 * nor fabricate one), and once the call's tool.result has landed.
 */
export function detectKimiPendingQuestion(
    cfg: NativeHistoryConfig | undefined,
    input: NativeHistoryInput,
): InteractivePrompt | null {
    if ((input.agentType ?? '').trim() !== 'kimi') return null;
    if (!cfg?.source || cfg.source.kind !== 'jsonl') return null;

    let sourcePath: string | null;
    try {
        sourcePath = resolveJsonlSourcePath(cfg.source, input);
    } catch {
        return null;
    }
    if (!sourcePath) return null;

    let records: unknown[];
    try {
        records = readTailJsonlLines(sourcePath, TAIL_BYTES);
    } catch {
        return null;
    }
    return detectKimiPendingQuestionFromRecords(records);
}

/**
 * Core detection over already-parsed wire.jsonl records (oldest→newest).
 * Exposed for tests so the pairing logic can be exercised without touching
 * disk — same seam style as background-task-detector's detectFromRecords.
 *
 * Latest-wins: with several AskUserQuestion calls in the tail, only the MOST
 * RECENT one can still be on screen (an earlier one necessarily resolved or
 * was superseded for the turn to advance), and even that one counts only when
 * no tool.result with its toolCallId follows it.
 */
export function detectKimiPendingQuestionFromRecords(records: unknown[]): InteractivePrompt | null {
    let latestCallIdx = -1;
    let latestCallId = '';
    let latestCallArgs: Record<string, unknown> | null = null;
    let latestCallTime = 0;

    for (let i = 0; i < records.length; i++) {
        const event = loopEvent(records[i]);
        if (!event) continue;
        if (event.type !== 'tool.call' || event.name !== 'AskUserQuestion') continue;
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
        if (!toolCallId) continue;
        latestCallIdx = i;
        latestCallId = toolCallId;
        latestCallArgs = event.args && typeof event.args === 'object'
            ? (event.args as Record<string, unknown>)
            : null;
        const time = (records[i] as Record<string, unknown>)?.time;
        latestCallTime = typeof time === 'number' && Number.isFinite(time) ? time : 0;
    }
    if (latestCallIdx < 0 || !latestCallId) return null;

    // Answered (in the terminal or via an injected answer): kimi appends the
    // tool.result for the same toolCallId and the turn continues. A later
    // turn.prompt also clears the hold — the turn moved on (e.g. the user
    // cancelled the picker with esc and prompted again), so the picker cannot
    // still be on screen.
    for (let i = latestCallIdx + 1; i < records.length; i++) {
        const record = records[i];
        if (record && typeof record === 'object'
            && String((record as Record<string, unknown>).type ?? '') === 'turn.prompt') {
            return null;
        }
        const event = loopEvent(record);
        if (!event || event.type !== 'tool.result') continue;
        const resultCallId = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
        if (resultCallId === latestCallId) return null;
    }

    // Normalize the question args into the shared InteractivePrompt shape.
    // `multi_select` (snake_case) is the wire spelling; `multiSelect` is
    // accepted defensively. allowFreeform is forced true: kimi ALWAYS renders
    // a trailing "Other" row on screen (it is NOT part of args.questions'
    // options, so it is not added to options either — the dashboard supplies
    // its own freeform escape against allowFreeform, mirroring the claude
    // convention).
    const rawQuestions = Array.isArray(latestCallArgs?.questions) ? latestCallArgs.questions : [];
    const questions = rawQuestions.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const q = raw as Record<string, unknown>;
        return {
            ...q,
            multiSelect: q.multiSelect === true || q.multi_select === true,
            allowFreeform: true,
        };
    });
    const prompt = normalizeInteractivePrompt({
        promptId: latestCallId,
        origin: 'cli',
        providerType: 'kimi',
        createdAt: latestCallTime || Date.now(),
        questions,
    });
    if (prompt) {
        LOG.info('KimiQuestion', `pending AskUserQuestion: promptId=${latestCallId} questions=${prompt.questions.length}`);
    }
    return prompt;
}

/** Unwrap a `context.append_loop_event` record's loop event, or null. */
function loopEvent(record: unknown): Record<string, unknown> | null {
    if (!record || typeof record !== 'object') return null;
    const r = record as Record<string, unknown>;
    if (String(r.type ?? '') !== 'context.append_loop_event') return null;
    const event = r.event;
    if (!event || typeof event !== 'object') return null;
    return event as Record<string, unknown>;
}

// ─── Built-in idle/cache-expired selector (screen-based) ─────────────────────

/**
 * promptId prefix for kimi's built-in TUI selectors (as opposed to
 * AskUserQuestion wire promptIds, which are toolCallIds). The answer path
 * branches on this prefix: the built-in selector renders NO numbered option
 * rows, so the AskUserQuestion digit protocol does not apply — navigation is
 * arrow keys + Enter ("↑↓ navigate · Enter select · Esc cancel").
 */
export const KIMI_TUI_SELECTOR_PROMPT_PREFIX = 'kimi-tui-selector-';

/** "This session has been idle for 32m and is ~392k tokens." */
const IDLE_SELECTOR_TITLE = /This session has been idle for/i;
/** Picker hint line: "↑↓ navigate · Enter select · Esc cancel". */
const IDLE_SELECTOR_HINT = /↑↓\s*navigate\s*·\s*Enter\s+select/i;

/**
 * One option row of the built-in selector: optional ❯ cursor, the label, then
 * an optional description separated from the label by 2+ spaces (the live
 * layout pads descriptions into a column; a label's own words are single-spaced,
 * and a row without a description — "Don't ask me again" — stays single-part).
 */
function parseSelectorRow(line: string): { label: string; description?: string } | null {
    const m = line.match(/^\s*(?:❯\s*)?(\S[\s\S]*?)\s*$/);
    if (!m) return null;
    const parts = m[1].split(/\s{2,}/);
    const label = (parts[0] ?? '').trim();
    if (!label) return null;
    const description = parts.length > 1 ? parts.slice(1).join(' ').trim() : undefined;
    return { label, ...(description ? { description } : {}) };
}

/**
 * Detect kimi's built-in idle/cache-expired selector on the live PTY screen
 * and build its InteractivePrompt. Layout (kimi 0.34 live capture):
 *
 *   ────────────────────────────────────────────────────────────
 *    This session has been idle for 32m and is ~392k tokens.
 *    ↑↓ navigate · Enter select · Esc cancel
 *
 *    Cache expired — the next message re-sends the entire history at full price.
 *     ❯ Compact and continue    one-time compact cost · cheapest way to keep th...
 *       Start a new session     zero context cost · best for a new task
 *       Continue as-is          full history kept · highest cost per turn
 *       Don't ask me again
 *   ────────────────────────────────────────────────────────────
 *
 * Anchors: the title line AND the hint line AND a ❯ cursor row with ≥2 option
 * rows — quoted prose mentioning one cue alone never parses. The question is
 * the body line between the hint and the option block ("Cache expired — …"),
 * so the volatile "idle for Nm" title is kept out of the question and only
 * rides along as the header: the content-fingerprint promptId stays stable
 * while the minutes tick up across polls.
 *
 * Returns null when the selector is not on screen (answered, dismissed, or
 * scrolled away — the caller clears any held prompt on null, same contract as
 * the wire detector).
 */
export function detectKimiIdleSelectorPrompt(screenText: string): InteractivePrompt | null {
    if (!screenText) return null;
    const lines = screenText.split('\n');

    let titleIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (IDLE_SELECTOR_TITLE.test(lines[i])) { titleIdx = i; break; }
    }
    if (titleIdx < 0) return null;

    let hintIdx = -1;
    for (let i = titleIdx + 1; i <= Math.min(lines.length - 1, titleIdx + 4); i += 1) {
        if (IDLE_SELECTOR_HINT.test(lines[i])) { hintIdx = i; break; }
    }
    if (hintIdx < 0) return null;

    // The ❯ cursor row is the first option row; the question body sits between
    // the hint and it. Stop at the closing separator — no cursor row visible.
    let cursorIdx = -1;
    for (let i = hintIdx + 1; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t) continue;
        if (/^─+$/.test(t)) break;
        if (t.startsWith('❯')) { cursorIdx = i; break; }
    }
    if (cursorIdx < 0) return null;

    const options: { label: string; description?: string }[] = [];
    for (let i = cursorIdx; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (!t || /^─+$/.test(t)) break;
        const row = parseSelectorRow(lines[i]);
        if (!row) break;
        options.push(row);
    }
    if (options.length < 2) return null;

    let question = '';
    for (let i = cursorIdx - 1; i > hintIdx; i -= 1) {
        const t = lines[i].trim();
        if (!t || /^─+$/.test(t)) continue;
        question = t;
        break;
    }
    if (!question) return null;

    const questions = [{
        questionId: 'q1',
        question,
        header: lines[titleIdx].trim(),
        multiSelect: false,
        options,
    }];
    return {
        promptId: `${KIMI_TUI_SELECTOR_PROMPT_PREFIX}${interactivePromptContentFingerprint(questions)}`,
        origin: 'cli',
        providerType: 'kimi',
        createdAt: Date.now(),
        questions,
    };
}

/**
 * Answer steps for the built-in selector: arrow keys relative to the ❯ cursor
 * row CURRENTLY on screen (re-read live at answer time), then Enter. The
 * selector has no digit shortcuts and no review screen, so this is exactly
 * |target − cursor| arrows + '\r' — the AskUserQuestion builder's digit
 * protocol and trailing review-screen Enter do NOT apply here.
 *
 * Fail-closed, same as the wire path: a single-select answer naming one known
 * option label or it throws (no index/default fallback, no freeform — the
 * selector renders no freeform row).
 */
export function buildKimiSelectorAnswerSteps(
    prompt: InteractivePrompt,
    response: InteractivePromptResponse,
    screenText: string,
): string[] {
    if (response.promptId !== prompt.promptId) throw new Error('Interactive prompt response does not match active prompt');
    if (prompt.questions.length !== 1) throw new Error('kimi built-in selector prompt must have exactly one question');
    const question = prompt.questions[0];
    const answer = response.answers[question.questionId];
    if (!answer) throw new Error(`Missing answer for ${question.questionId}`);
    if (answer.freeformText?.trim()) throw new Error('kimi built-in selector has no freeform input');
    if (answer.selectedLabels.length !== 1) throw new Error(`Expected one selected label for ${question.questionId}`);
    const target = question.options.findIndex((o) => o.label === answer.selectedLabels[0]);
    if (target < 0) throw new Error(`Unknown option for ${question.questionId}: ${answer.selectedLabels[0]}`);

    let cursor = 0;
    for (const line of (screenText ?? '').split('\n')) {
        if (!line.trim().startsWith('❯')) continue;
        const row = parseSelectorRow(line);
        if (!row) continue;
        const idx = question.options.findIndex((o) => o.label === row.label);
        if (idx >= 0) { cursor = idx; break; }
    }

    const steps: string[] = [];
    const diff = target - cursor;
    const key = diff > 0 ? '\x1b[B' : '\x1b[A';
    for (let i = 0; i < Math.abs(diff); i += 1) steps.push(key);
    steps.push('\r');
    return steps;
}


export interface KimiQuestionSnapshot {
    state: 'loading' | 'ready' | 'unavailable';
    prompt: InteractivePrompt | null;
    resolution?: JsonlSourceResolution;
    background?: BackgroundTaskDetection;
}
type KimiHeader = { native_history?: NativeHistoryConfig; interactive_prompts?: InteractivePrompts };

/** One reader per adapter incarnation. Status reads are memory-only; watchers
 * and the fallback reconcile timer perform asynchronous revision checks. No
 * unchanged reconcile enumerates directories or rereads question records. */
export class KimiPendingQuestionReader {
    private generation = 0;
    private sourceEpoch = 0;
    private closed = false;
    private key = '';
    private cfg?: NativeHistoryConfig;
    private input: NativeHistoryInput = {};
    private snapshot: KimiQuestionSnapshot = { state: 'ready', prompt: null };
    private evidence?: SidecarSourceEvidence;
    private binding?: JsonlSourceResolution;
    private revisions = new Map<string, string>();
    private watchers: fs.FSWatcher[] = [];
    private configWatcher?: fs.FSWatcher;
    private configSeal?: string;
    private configSequence = 0;
    private configPending?: Promise<void>;
    private configLoaded = false;
    private pending?: Promise<void>;
    private dirty = false;
    private policy = '';
    private retry?: ReturnType<typeof setTimeout>;
    private timer?: ReturnType<typeof setInterval>;

    constructor(
        private readonly onChange: () => void,
        private specPath?: string,
        private readonly onHeader?: (header: KimiHeader) => void,
        private readonly currentInput?: () => NativeHistoryInput,
        // Background reads retain their owner-free resolution policy; never
        // borrow an owner-claimed question binding across attribution policies.
        private readonly backgroundOnly = false,
    ) {}

    private identity(cfg = this.cfg, input = this.currentInput?.() ?? this.input): string {
        const expanded = cfg?.source?.kind === 'jsonl'
            ? expandPath(cfg.source.path, input, { skipWorkspaceRealpath: true }) : '';
        const env = Object.entries(input.envOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b));
        return JSON.stringify([this.specPath, cfg, input.agentType, input.providerSessionId, input.sessionId,
            input.historySessionId, input.sessionStartedAtMs, input.instanceId, input.workspace, env, expanded]);
    }
    private policyIdentity(): string {
        return JSON.stringify([sentPromptSnippets(this.input.instanceId),
            this.evidence?.candidates.map(c => [c.key, transcriptClaimOwner(c.key)])]);
    }
    private current(generation: number, key: string): boolean {
        return !this.closed && !this.configPending && generation === this.generation && key === this.identity();
    }
    private emit(): void { if (!this.closed) this.onChange(); }
    private setSnapshot(next: KimiQuestionSnapshot): void {
        const changed = next.state !== this.snapshot.state || next.prompt?.promptId !== this.snapshot.prompt?.promptId
            || JSON.stringify(next.background) !== JSON.stringify(this.snapshot.background);
        this.snapshot = next;
        if (changed) this.emit();
    }
    private clearWatches(): void { for (const w of this.watchers) w.close(); this.watchers = []; }
    private invalidate(): void {
        this.generation++;
        this.evidence = undefined;
        this.binding = undefined;
        this.revisions.clear();
        this.clearWatches();
        this.snapshot = { state: 'loading', prompt: null };
        this.dirty = true;
    }

    read(cfg: NativeHistoryConfig | undefined, input: NativeHistoryInput): KimiQuestionSnapshot {
        if (this.closed) return { state: 'unavailable', prompt: null };
        this.cfg = cfg;
        this.input = input;
        const key = this.identity();
        if (key !== this.key) { this.key = key; this.invalidate(); }
        if (this.specPath && !this.configLoaded) this.request();
        if (!this.timer && (this.specPath || input.agentType === 'kimi' && cfg?.source?.kind === 'jsonl')) {
            this.timer = setInterval(() => this.request(), 1_000); this.timer.unref?.();
        }
        if (input.agentType !== 'kimi' || cfg?.source?.kind !== 'jsonl') {
            this.snapshot = { state: 'ready', prompt: null };
            return this.snapshot;
        }
        if (this.binding?.claimKey && this.binding.outcome?.ownerConfirmed) {
            const owner = transcriptClaimOwnerToken(input.instanceId);
            if (owner && claimTranscript(this.binding.claimKey, owner) === 'denied') {
                this.binding = undefined;
                this.snapshot = { state: 'unavailable', prompt: null };
                this.dirty = true;
            }
        }
        if (!this.binding && this.policy !== this.policyIdentity()) this.dirty = true;
        if (this.dirty) this.request();
        return this.snapshot;
    }

    /** Explicit provider-definition refresh and the spec watch share this path. */
    reloadConfig(specPath = this.specPath, force = true): Promise<void> {
        if (this.closed || !specPath) return Promise.resolve();
        const wasLoaded = this.configLoaded;
        if (specPath !== this.specPath) { this.configWatcher?.close(); this.configWatcher = undefined; this.specPath = specPath; this.configLoaded = false; }
        const sequence = ++this.configSequence;
        // Invalidate synchronously before awaiting config I/O: an old discovery
        // cannot claim during a provider-definition replacement.
        if (wasLoaded && force) this.invalidate();
        const work = (async () => {
            if (!this.configWatcher) {
                try {
                    this.configWatcher = fs.watch(path.dirname(specPath), { persistent: false }, (_event, filename) => {
                        if (!filename || String(filename) === path.basename(specPath)) void this.reloadConfig(this.specPath, false);
                    });
                    this.configWatcher.on('error', () => { this.configWatcher?.close(); this.configWatcher = undefined; });
                } catch { /* async reconcile still checks the config seal */ }
            }
            const before = await sourceRevisionAsync(specPath);
            let header: KimiHeader;
            try {
                const raw = JSON.parse(await fs.promises.readFile(specPath, 'utf8'));
                if (!raw || typeof raw !== 'object' || (raw.id && raw.id !== this.input.agentType)) throw new Error('provider mismatch');
                if (raw.native_history?.source && (raw.native_history.source.kind !== 'jsonl'
                    || typeof raw.native_history.source.path !== 'string')) throw new Error('unsupported source');
                header = { native_history: raw.native_history, interactive_prompts: raw.interactive_prompts };
            } catch { header = { native_history: undefined, interactive_prompts: undefined }; }
            const after = await sourceRevisionAsync(specPath);
            if (this.closed || sequence !== this.configSequence) return;
            if (before !== after) { this.defer(); return; }
            const changed = this.configSeal !== undefined && this.configSeal !== after
                || JSON.stringify(this.cfg) !== JSON.stringify(header.native_history);
            this.configSeal = after;
            this.configLoaded = true;
            if (changed) this.invalidate();
            this.cfg = header.native_history;
            this.onHeader?.(header);
            this.key = this.identity();
        })();
        this.configPending = work;
        void work.finally(() => {
            if (this.configPending === work) { this.configPending = undefined; this.request(); this.emit(); }
        }).catch(() => {});
        return work;
    }

    private defer(): void {
        if (this.retry || this.closed) return;
        this.retry = setTimeout(() => { this.retry = undefined; this.request(); }, 25);
        this.retry.unref?.();
    }
    private request(): void {
        if (this.closed) return;
        this.dirty = true;
        if (this.pending || this.configPending) return;
        const generation = this.generation;
        const work = Promise.resolve().then(async () => {
            if (!this.configLoaded && this.specPath) await this.reloadConfig();
            if (this.closed || this.configPending) return;
            this.dirty = false;
            await this.refresh();
        }).catch(() => { if (!this.closed && generation === this.generation) this.setSnapshot({ state: 'unavailable', prompt: this.snapshot.prompt }); });
        this.pending = work;
        void work.finally(() => {
            if (this.pending !== work) return;
            this.pending = undefined;
            if (this.dirty && !this.closed) this.defer();
        });
    }

    /** Test/embedding drain seam; no timers or polling of active sessions. */
    async whenSettled(reconcile = false): Promise<void> {
        if (reconcile) this.request();
        for (let turn = 0; turn < 32; turn++) {
            if (this.dirty && !this.pending && !this.configPending && !this.closed) {
                if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
                this.request();
            }
            const pending = this.configPending ?? this.pending;
            if (!pending) break;
            await pending;
        }
    }
    private watch(revisions: Map<string, string>, bound: boolean): void {
        this.clearWatches();
        for (const [p, revision] of revisions) {
            if (revision === 'missing') continue;
            try {
                const watched = bound ? path.dirname(p) : p;
                const watcher = fs.watch(watched, { persistent: false }, (_event, name) => {
                    if (!bound || !name || String(name) === path.basename(p)) { this.sourceEpoch++; this.markBackgroundPending(); this.request(); }
                });
                watcher.on('error', () => { this.sourceEpoch++; this.markBackgroundPending(); this.request(); });
                this.watchers.push(watcher);
            } catch { /* timer validates all levels, even if native watch limits are reached */ }
        }
    }
    private markBackgroundPending(): void {
        if (this.backgroundOnly && !this.closed && this.snapshot.state === 'ready') {
            this.setSnapshot({ ...this.snapshot, state: 'loading' });
        }
    }
    private async refresh(): Promise<void> {
        const generation = this.generation;
        const key = this.key;
        const sourceEpoch = this.sourceEpoch;
        const valid = () => this.current(generation, key) && sourceEpoch === this.sourceEpoch;
        const cfg = this.cfg;
        const input = { ...this.input, envOverrides: { ...this.input.envOverrides } };
        if (!valid()) return;
        if (this.specPath && this.configSeal !== await sourceRevisionAsync(this.specPath)) { await this.reloadConfig(this.specPath, false); return; }
        if (cfg?.source?.kind !== 'jsonl') return;
        let changed = false;
        for (const [p, revision] of this.revisions) if (await sourceRevisionAsync(p) !== revision) { changed = true; break; }
        if (!valid()) return;
        if (changed) this.markBackgroundPending();
        if (this.evidence && input.workspace && await canonicalSourcePathAsync(input.workspace) !== this.evidence.workspaceKey) {
            if (valid()) { this.invalidate(); this.emit(); }
            return;
        }
        if (this.binding?.path) {
            const p = this.binding.path;
            const before = this.revisions.get(p)!;
            const now = await sourceRevisionAsync(p);
            const sidecar = cfg.source.workspace_from_sidecar
                ? path.resolve(path.dirname(p), cfg.source.workspace_from_sidecar.rel_path) : undefined;
            const sameIdentity = now.split(':').slice(0, 2).join(':') === before.split(':').slice(0, 2).join(':');
            const sourceChanged = now !== before && (!sameIdentity || Number(now.split(':')[2]) <= Number(before.split(':')[2]));
            if (sourceChanged || sidecar && await sourceRevisionAsync(sidecar) !== this.revisions.get(sidecar)) {
                if (valid()) { this.invalidate(); this.emit(); }
                return;
            }
            if (!changed && this.snapshot.state === 'ready') return;
        } else {
            if (this.evidence && !changed && this.policy === this.policyIdentity() && this.snapshot.state === 'unavailable') return;
            const promptChanged = this.evidence?.promptIdentity !== JSON.stringify(sentPromptSnippets(input.instanceId));
            const result = this.evidence && !changed && !promptChanged
                ? resolveJsonlSidecarSourceFromEvidence(cfg.source, input, this.evidence, valid)
                : await resolveJsonlSidecarSourceAsync(cfg.source, input, { isCurrent: valid, evidence: !changed ? this.evidence : undefined });
            if (!valid()) return;
            if (result.stale) { this.dirty = true; return; }
            this.evidence = result.evidence;
            this.policy = this.policyIdentity();
            if (!result.path) {
                this.revisions = this.evidence?.revisions ?? new Map();
                this.watch(this.revisions, false);
                this.setSnapshot({ state: 'unavailable', prompt: null, resolution: result });
                return;
            }
            this.binding = { ...result, evidence: undefined };
            this.revisions = new Map([[result.path, this.evidence!.revisions.get(result.path)!]]);
            const sidecar = cfg.source.workspace_from_sidecar;
            if (sidecar) {
                const p = path.resolve(path.dirname(result.path), sidecar.rel_path);
                this.revisions.set(p, this.evidence!.revisions.get(p)!);
            }
            this.evidence = { ...this.evidence!, candidates: this.evidence!.candidates.filter(c => c.p === result.path), revisions: this.revisions };
            this.watch(this.revisions, true);
        }
        const source = this.binding!.path!;
        const tail = await readTailJsonlLinesAsync(source, TAIL_BYTES, valid);
        if (!valid()) return;
        if (!tail) { this.dirty = true; return; }
        // Reject a replacement between resolution and the tail read, too.
        const expected = this.revisions.get(source)!.split(':').slice(0, 2).join(':');
        if (tail.signature.split(':').slice(0, 2).join(':') !== expected) { this.invalidate(); this.emit(); return; }
        const sidecar = cfg.source.workspace_from_sidecar;
        if (sidecar) {
            const p = path.resolve(path.dirname(source), sidecar.rel_path);
            if (await sourceRevisionAsync(p) !== this.revisions.get(p)) { if (valid()) { this.invalidate(); this.emit(); } return; }
        }
        if (!valid()) return;
        this.revisions.set(source, tail.signature);
        this.setSnapshot({ state: 'ready', prompt: this.backgroundOnly ? null : detectKimiPendingQuestionFromRecords(tail.records),
            ...(this.backgroundOnly ? { background: detectFromRecords(tail.records, 'kimi') } : {}), resolution: this.binding });
    }
    dispose(): void {
        this.closed = true;
        this.generation++;
        this.configSequence++;
        this.clearWatches();
        this.configWatcher?.close();
        if (this.timer) clearInterval(this.timer);
        if (this.retry) clearTimeout(this.retry);
        this.evidence = undefined;
        this.binding = undefined;
        this.snapshot = { state: 'unavailable', prompt: null };
    }
}
