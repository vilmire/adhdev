/**
 * chat-row-model — decide, ONCE per message, how a chat row looks.
 *
 * `resolveChatRow` is the only place that classifies a message for the chat
 * list (design 2026-10-07-chat-row-model.md §2.1). The list calls it per
 * message, partitions on `surface`, and hands the model to the row; the row
 * renders the model and never re-derives kind, label or visibility. The memo
 * signature is built from the same model, so it cannot drift from what renders.
 *
 * Pure: no React. Labels are i18n keys (or verbatim daemon/user text), resolved
 * by the shell.
 */

import { buildChatMessageSignature, hashSignatureParts } from '@adhdev/daemon-core/chat/chat-signatures';
import { stringifyTextContent } from '../../utils/text';
import { classifyChatMessageForDisplay, type ChatTranscriptSurface } from '../dashboard/chat-activity-visibility';
import type { ChatMessage } from '../../types';
import {
    getChatMessageStableKey,
    getToolExpandAddress,
    getToolExpandStateKey,
    isStructuredMessagePartArray,
    likelyNeedsMarkdownRender,
    type StructuredMessagePart,
    type ToolExpandAddress,
} from './chatMessageHelpers';
import { extractReplyChoices } from './reply-choices';
import { detectInjectedText, type InjectedSegment, type InjectedSource } from './injected-text';

export type ChatRowKind = 'user' | 'assistant' | 'system' | 'injected' | 'tool' | 'thought' | 'terminal' | 'activity';

export type RowIcon = 'thought' | 'tool-dot' | 'activity-dot' | 'running' | 'done' | 'git';

/** Either verbatim text (sender name, daemon-derived tool label) or an i18n key. */
export type RowLabel =
    | { text: string }
    | { i18nKey: string };

export type RowBody =
    | { type: 'markdown'; text: string }
    | { type: 'plain'; text: string }
    | { type: 'pre'; text: string }
    | { type: 'parts'; parts: StructuredMessagePart[]; preformatted: boolean };

/**
 * How the body folds.
 *  - `local`: the full text is on the message; show `previewChars` + `…` past
 *    `threshold` until expanded.
 *  - `remote`: the parser truncated it; the full body is fetched from the
 *    daemon (`expand_tool_block`) by `address`.
 */
export type RowCollapse =
    | { mode: 'none' }
    | { mode: 'local'; threshold: number; previewChars: number }
    | { mode: 'remote'; address: ToolExpandAddress; previewChars?: number };

export interface RowStatus {
    /** The optimistic bubble the daemon accepted but has not yet written. */
    queued?: { pendingId: string };
}

export interface InjectedMeta {
    source: InjectedSource;
    segments: InjectedSegment[];
}

export interface ChatRowModel {
    /** The message's stable key (`getChatMessageStableKey`, base tier). */
    key: string;
    /** Expansion identity for a tool BLOCK when it has one (`getToolExpandStateKey`). */
    expandKey: string | null;
    kind: ChatRowKind;
    surface: ChatTranscriptSurface;
    label: RowLabel;
    icon: RowIcon | null;
    timestamp: number | null;
    /** Null hides the copy button. */
    copyText: string | null;
    body: RowBody;
    collapse: RowCollapse;
    injected?: InjectedMeta;
    status?: RowStatus;
    /** Assistant question with fixed answers: the options (choices line stripped from the body). */
    replyChoices?: string[];
    /** Render signature — every field above folded in. Memo comparators use this. */
    signature: string;
}

export interface ResolveChatRowContext {
    agentName?: string;
    userName?: string;
    /** Explicit receive time (a row rendered outside the list). */
    receivedAt?: number | null;
    /** The list's received-time cache, keyed by base stable key. */
    receivedAtMap?: Record<string, number>;
}

// System rows (git errors, status lines, long file paths) fold at one terminal
// line of context — enough to identify the message without dominating the
// column (G8).
export const SYSTEM_ROW_COLLAPSE = { mode: 'local', threshold: 100, previewChars: 100 } as const;
// Native-turn tool rows arrive as a plaintext string with no toolBlockRef. Fold
// at the cap the spec-history parser uses for tool *results*
// (`TOOL_RESULT_SUMMARY_MAX` in daemon-core native-history-tool-blocks.ts).
export const TOOL_ROW_COLLAPSE = { mode: 'local', threshold: 600, previewChars: 599 } as const;

// A tool RESULT is the call's output, usually a JSON blob; one short line says
// enough to recognise it, the rest is one tap away.
export const TOOL_RESULT_ROW_COLLAPSE = { mode: 'local', threshold: 160, previewChars: 140 } as const;

const ACTIVITY_KINDS = new Set(['thought', 'tool', 'terminal']);

/**
 * MCP tools arrive as `mcp__<server>__<tool>`; the server prefix is plumbing.
 */
export function humanizeToolName(name: string): string {
    const trimmed = name.trim();
    const match = /^mcp__.+?__(.+)$/.exec(trimmed);
    return match ? match[1] : trimmed;
}

interface ToolText {
    /** Call: the tool name from the `↗ name:` line, humanized. */
    name: string;
    /** `↘ …` result line. */
    isResult: boolean;
    /** The text without the arrow and, for a call, without the repeated name. */
    body: string;
}

/**
 * Spec-history tool rows are `↗ {name}: {args}` / `↘ {result}`
 * (daemon-core native-history-tool-blocks.ts). The header already shows the
 * name, so the body keeps only what is new.
 */
export function presentToolText(text: string): ToolText {
    const call = /^\s*↗\s*([^\s:]+)(?::\s*([\s\S]*))?$/.exec(text);
    if (call) return { name: humanizeToolName(call[1]), isResult: false, body: (call[2] ?? '').trim() };
    const result = /^\s*↘\s*([\s\S]*)$/.exec(text);
    if (result) return { name: '', isResult: true, body: result[1].trim() };
    return { name: '', isResult: false, body: text };
}

function readMeta(message: ChatMessage): Record<string, unknown> {
    const meta = message.meta;
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
}

function metaLabel(meta: Record<string, unknown>): string {
    return typeof meta.label === 'string' ? meta.label : '';
}

function labelOr(text: string, i18nKey: string): RowLabel {
    return text ? { text } : { i18nKey };
}

function resolveKind(message: ChatMessage, role: string, isActivityFacing: boolean, injected: InjectedMeta | undefined): ChatRowKind {
    if (injected) return injected.source === 'system' ? 'system' : 'injected';
    const rawKind = message.kind || (role === 'tool' ? 'tool' : 'standard');
    if (isActivityFacing && !ACTIVITY_KINDS.has(rawKind)) return 'activity';
    if (rawKind === 'thought' || rawKind === 'tool' || rawKind === 'terminal' || rawKind === 'system') return rawKind as ChatRowKind;
    if (role === 'system') return 'system';
    return role === 'user' || role === 'human' ? 'user' : 'assistant';
}

function resolveLabel(kind: ChatRowKind, message: ChatMessage, meta: Record<string, unknown>, ctx: ResolveChatRowContext, activityLabelKey: string): RowLabel {
    switch (kind) {
        case 'user': return labelOr(ctx.userName || '', 'chat.you');
        case 'assistant': return labelOr(message.senderName || ctx.agentName || '', 'chat.agent');
        // Header label: the daemon derives meta.label from the reader's toolName
        // when it resolved one (chat-commands-read-native-normalize.ts).
        case 'tool': {
            const presented = presentToolText(stringifyTextContent(message.content, { joiner: '\n' }));
            const named = humanizeToolName(metaLabel(meta) || (typeof message.toolName === 'string' ? message.toolName : '') || presented.name);
            return labelOr(named, presented.isResult ? 'chat.toolResult' : 'chat.tool');
        }
        case 'thought': return labelOr(metaLabel(meta), 'chat.thought');
        case 'terminal': return labelOr(metaLabel(meta), 'chat.ranCommand');
        case 'activity': return labelOr(metaLabel(meta).trim(), activityLabelKey);
        case 'system': return { i18nKey: 'chat.system' };
        case 'injected': return { i18nKey: 'chat.injected' };
    }
}

function resolveIcon(kind: ChatRowKind, meta: Record<string, unknown>): RowIcon | null {
    switch (kind) {
        case 'thought': return 'thought';
        case 'tool': return 'tool-dot';
        case 'activity': return 'activity-dot';
        case 'terminal': return meta.isRunning ? 'running' : 'done';
        case 'system': return meta.source === 'git-system-bubble' ? 'git' : null;
        default: return null;
    }
}

function resolveBody(kind: ChatRowKind, text: string, parts: StructuredMessagePart[] | null, meta: Record<string, unknown>): RowBody {
    const renderMode = typeof meta.renderMode === 'string' ? meta.renderMode.trim() : '';
    const preformatted = renderMode === 'preformatted';
    if (parts) return { type: 'parts', parts, preformatted: kind === 'terminal' || ((kind === 'user' || kind === 'assistant') && preformatted) };
    if (kind === 'terminal') return { type: 'pre', text };
    if (kind === 'assistant') {
        if (preformatted) return { type: 'pre', text };
        if (likelyNeedsMarkdownRender(text)) return { type: 'markdown', text };
    }
    // User-authored text renders verbatim — never markdown — so `*foo*` stays
    // literal and intentional newlines survive.
    if (kind === 'user' && preformatted) return { type: 'pre', text };
    return { type: 'plain', text };
}

function resolveCollapse(kind: ChatRowKind, message: ChatMessage, text: string, hasParts: boolean): RowCollapse {
    if (hasParts) return { mode: 'none' };
    if (kind === 'tool') {
        // (TOOL-EXPAND) The parser stamps a ref only on bubbles it truncated, so
        // the affordance appears exactly where there is more text to fetch.
        const isResult = presentToolText(text).isResult;
        const address = getToolExpandAddress(message);
        // A truncated result still folds to the short preview until fetched.
        if (address) return isResult ? { mode: 'remote', address, previewChars: TOOL_RESULT_ROW_COLLAPSE.previewChars } : { mode: 'remote', address };
        const rule = isResult ? TOOL_RESULT_ROW_COLLAPSE : TOOL_ROW_COLLAPSE;
        return text.length > rule.threshold ? rule : { mode: 'none' };
    }
    if (kind === 'system') return text.length > SYSTEM_ROW_COLLAPSE.threshold ? SYSTEM_ROW_COLLAPSE : { mode: 'none' };
    return { mode: 'none' };
}

function resolveStatus(meta: Record<string, unknown>): RowStatus | undefined {
    if (meta.pendingLocal !== true || meta.queued !== true) return undefined;
    return { queued: { pendingId: typeof meta.pendingId === 'string' ? meta.pendingId : '' } };
}

function labelSignature(label: RowLabel): string {
    return 'text' in label ? `t:${label.text}` : `k:${label.i18nKey}`;
}

function collapseSignature(collapse: RowCollapse): string {
    if (collapse.mode === 'local') return `local:${collapse.threshold}:${collapse.previewChars}`;
    if (collapse.mode === 'remote') {
        const a = collapse.address;
        const where = 'messageId' in a ? `mid:${a.messageId}` : `ref:${a.toolBlockRef.recordIndex}:${a.toolBlockRef.blockIndex}:${a.toolBlockRef.sourceMtimeMs}`;
        return `remote:${where}:${collapse.previewChars ?? ''}`;
    }
    return 'none';
}

function buildSignature(message: ChatMessage, model: Omit<ChatRowModel, 'signature'>): string {
    const body = model.body;
    return hashSignatureParts([
        // id / index / role / time / full content hash.
        buildChatMessageSignature(message),
        model.key,
        model.expandKey ?? '',
        model.kind,
        model.surface,
        labelSignature(model.label),
        model.icon ?? '',
        String(model.timestamp ?? ''),
        model.copyText === null ? '' : 'copy',
        body.type === 'parts' ? `parts:${body.preformatted}` : body.type,
        collapseSignature(model.collapse),
        model.status?.queued ? `queued:${model.status.queued.pendingId}` : '',
        model.injected ? model.injected.segments.map((s) => `${s.source}:${s.project ?? ''}:${s.outcome ?? ''}:${s.idle ? 1 : 0}`).join(',') : '',
        model.replyChoices ? model.replyChoices.join('\u0001') : '',
    ]);
}

/**
 * Model cache keyed by message identity. Transcript messages are immutable
 * snapshots (a changed field arrives as a NEW object — see
 * `withPendingLocalMessage`), so identity plus the context it was resolved with
 * fully determines the model. WeakMap so scrolled-off messages are collected.
 */
interface CachedRow {
    agentName?: string;
    userName?: string;
    receivedAt?: number | null;
    receivedAtMap?: Record<string, number>;
    model: ChatRowModel;
}
const rowCache = new WeakMap<ChatMessage, CachedRow>();

function computeChatRow(message: ChatMessage, ctx: ResolveChatRowContext): ChatRowModel {
    const classification = classifyChatMessageForDisplay(message);
    const meta = readMeta(message);
    const role = (message.role || '').toLowerCase();
    const structured = isStructuredMessagePartArray(message.content) ? message.content : null;
    const parts = structured?.some((part) => part.type !== 'text') ? structured : null;
    const rawText = stringifyTextContent(message.content, { joiner: '\n' });

    // A PTY-hosted session records daemon-typed input as USER turns. The
    // owner's own optimistic bubble is never injected.
    const detected = (role === 'user' || role === 'human') && !parts && meta.pendingLocal !== true
        ? detectInjectedText(rawText)
        : null;
    const injected = detected ? { source: detected.source, segments: detected.segments } : undefined;

    const kind = resolveKind(message, role, classification.isActivityFacing, injected);
    // An assistant question may end with a `[[choices: …]]` line: never shown,
    // offered as answer buttons instead (reply-choices.ts).
    const extracted = kind === 'assistant' && !parts ? extractReplyChoices(rawText) : null;
    const text = extracted ? extracted.text : rawText;
    const key = getChatMessageStableKey(message, 0);
    const receivedAt = ctx.receivedAt !== undefined
        ? ctx.receivedAt
        : (Number(message.receivedAt || ctx.receivedAtMap?.[key] || 0) || null);

    const model: Omit<ChatRowModel, 'signature'> = {
        key,
        expandKey: getToolExpandStateKey(message),
        kind,
        surface: classification.surface,
        label: resolveLabel(kind, message, meta, ctx, classification.labelKey),
        icon: resolveIcon(kind, meta),
        timestamp: receivedAt || null,
        copyText: text ? text : null,
        body: resolveBody(kind, kind === 'tool' && !parts ? presentToolText(text).body : text, parts, meta),
        collapse: resolveCollapse(kind, message, text, !!parts),
        ...(injected ? { injected } : {}),
        ...(kind === 'user' ? { status: resolveStatus(meta) } : {}),
        ...(extracted && extracted.choices.length ? { replyChoices: extracted.choices } : {}),
    };
    if (model.status === undefined) delete model.status;
    return { ...model, signature: buildSignature(message, model) };
}

export function resolveChatRow(message: ChatMessage, ctx: ResolveChatRowContext = {}): ChatRowModel {
    const cached = rowCache.get(message);
    if (cached
        && cached.agentName === ctx.agentName
        && cached.userName === ctx.userName
        && cached.receivedAt === ctx.receivedAt
        && cached.receivedAtMap === ctx.receivedAtMap) {
        return cached.model;
    }
    const model = computeChatRow(message, ctx);
    rowCache.set(message, { agentName: ctx.agentName, userName: ctx.userName, receivedAt: ctx.receivedAt, receivedAtMap: ctx.receivedAtMap, model });
    return model;
}
