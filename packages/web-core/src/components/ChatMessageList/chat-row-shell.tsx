/**
 * chat-row-shell — the one frame every chat row is drawn in.
 *
 *   header   icon · label · [time · copy]
 *   body     markdown | plain | pre | parts
 *   footer   one Collapsible (local fold or remote fetch, same button and copy)
 *
 * Kinds differ only by the model's values and by `ROW_VARIANTS`, which keeps
 * the existing DOM classes (`.chat-bubble`, `.chat-msg-tool`, `.tool-label`,
 * `.chat-msg-system-expand`, …) as variant classes so styles and tests that
 * select on them stay valid. Every root also carries `chat-row chat-row-<kind>`.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconThought, IconCheck, IconSpinner, IconGitBranch } from '../Icons';
import { formatTime } from './chatMessageHelpers';
import type { ToolExpandAddress } from './chatMessageHelpers';
import { CopyButton, RowBodyView } from './chat-row-content';
import type { ChatRowKind, ChatRowModel, RowCollapse, RowIcon, RowLabel } from './chat-row-model';
import type { ToolExpandState } from './chat-row-expansion';

interface RowVariant {
    /** Outer row wrapper (conversation bubbles sit inside an alignment row). */
    outer?: string;
    root: string;
    header: string;
    headerAria?: string;
    label: string;
    meta: string;
    /** `null`: inline content, no wrapper (the compact system row). */
    body: string | null;
    bodyPre?: boolean;
    expand: string;
    /** Header after the body (inline system row: text … time · copy). */
    headerLast?: boolean;
    /** Label shown in the header (system rows keep it for a11y only). */
    showLabel?: boolean;
}

const BUBBLE_HEADER = 'chat-bubble-header';

export const ROW_VARIANTS: Record<Exclude<ChatRowKind, 'injected'>, RowVariant> = {
    user: { outer: 'chat-message-row chat-message-row-user self-end', root: 'chat-bubble chat-bubble-user', header: BUBBLE_HEADER, label: 'chat-sender', meta: 'chat-bubble-header-end', body: 'chat-markdown', expand: 'chat-bubble-expand', showLabel: true },
    assistant: { outer: 'chat-message-row chat-message-row-assistant self-start', root: 'chat-bubble chat-bubble-assistant', header: BUBBLE_HEADER, label: 'chat-sender', meta: 'chat-bubble-header-end', body: 'chat-markdown', expand: 'chat-bubble-expand', showLabel: true },
    tool: { root: 'self-start chat-msg-tool', header: 'chat-msg-tool-meta', headerAria: 'chat.toolMessageAria', label: 'tool-label', meta: 'chat-bubble-header-end chat-msg-tool-header-end', body: 'tool-text w-full', expand: 'chat-msg-tool-expand', showLabel: true },
    thought: { root: 'self-start chat-msg-thought', header: 'chat-msg-header', label: 'chat-row-label', meta: 'chat-bubble-header-end', body: 'chat-msg-body', expand: 'chat-msg-thought-expand', showLabel: true },
    terminal: { root: 'self-start chat-msg-terminal', header: 'chat-msg-header', label: 'chat-row-label', meta: 'chat-bubble-header-end', body: 'chat-msg-body', bodyPre: true, expand: 'chat-msg-terminal-expand', showLabel: true },
    activity: { root: 'self-start chat-msg-activity', header: 'chat-msg-activity-meta', headerAria: 'chat.activityMessageAria', label: 'chat-row-label', meta: 'chat-bubble-header-end', body: 'chat-msg-activity-body', expand: 'chat-msg-activity-expand', showLabel: true },
    system: { root: 'self-center chat-msg-system', header: 'chat-msg-system-meta', label: 'chat-row-label', meta: 'chat-bubble-header-end', body: null, expand: 'chat-msg-system-expand', headerLast: true },
};

export function useRowLabel(label: RowLabel): string {
    const { t } = useTranslation('common');
    return 'text' in label ? label.text : t(label.i18nKey);
}

export function RowIconView({ icon }: { icon: RowIcon | null }) {
    switch (icon) {
        case 'thought': return <IconThought size={13} />;
        case 'tool-dot': return <span className="tool-icon" aria-hidden="true" />;
        case 'activity-dot': return <span className="activity-dot" />;
        case 'running': return <span><IconSpinner size={12} /></span>;
        case 'done': return <span><IconCheck size={12} /></span>;
        case 'git': return <span className="chat-row-icon" aria-hidden="true"><IconGitBranch size={11} /></span>;
        default: return null;
    }
}

/** Time · copy — present on every kind (time only when the row has one). */
export function RowMeta({ className, copyText, timestamp }: { className: string; copyText: string | null; timestamp: number | null }) {
    if (copyText === null && timestamp === null) return null;
    return (
        <span className={`chat-row-meta ${className}`}>
            {copyText !== null && <CopyButton text={copyText} />}
            {timestamp !== null && <span className="chat-time">{formatTime(timestamp)}</span>}
        </span>
    );
}

export interface CollapsibleProps {
    collapse: RowCollapse;
    className: string;
    /** Locally open (fold toggled). */
    expanded: boolean;
    onToggle?: () => void;
    /** Remote fetch state + handlers; a host with no transport passes none. */
    remoteState?: ToolExpandState;
    onExpandRemote?: (address: ToolExpandAddress) => void;
    onCollapseRemote?: () => void;
}

/**
 * The one expand / collapse control. Local folds and remote fetches share the
 * button and its copy; a remote fetch adds the loading and refusal states.
 */
export function Collapsible({ collapse, className, expanded, onToggle, remoteState, onExpandRemote, onCollapseRemote }: CollapsibleProps) {
    const { t } = useTranslation('common');
    const cls = `chat-row-expand ${className}`;
    if (collapse.mode === 'none') return null;
    if (collapse.mode === 'remote') {
        if (!onExpandRemote) return null;
        if (remoteState?.status === 'loading') {
            return <div className={cls} aria-live="polite">{t('chat.toolExpandLoading')}</div>;
        }
        if (remoteState?.status === 'error') {
            // Two branches, not five: "stale, reload" vs "cannot be fetched". An
            // unknown/absent reason takes the generic branch — the honest answer
            // when we do not know why.
            const isStale = remoteState.error === 'source_changed';
            return (
                <div className={`${cls} chat-row-expand-error ${className}-error`} role="status" data-expand-error-reason={remoteState.error ?? 'unknown'}>
                    {isStale ? t('chat.toolExpandStale') : t('chat.toolExpandUnavailable')}
                </div>
            );
        }
        const open = remoteState?.status === 'expanded';
        return (
            <button type="button" className={cls} aria-expanded={open} onClick={open ? onCollapseRemote : () => onExpandRemote(collapse.address)}>
                {open ? t('chat.toolCollapse') : t('chat.toolExpand')}
            </button>
        );
    }
    if (!onToggle) return null;
    return (
        <button type="button" className={cls} aria-expanded={expanded} onClick={onToggle}>
            {expanded ? t('chat.toolCollapse') : t('chat.toolExpand')}
        </button>
    );
}

/** The text a folded / fetched body shows. */
export function resolveDisplayedText(model: ChatRowModel, expanded: boolean, remoteState?: ToolExpandState): string | undefined {
    if (model.body.type === 'parts') return undefined;
    const full = remoteState?.status === 'expanded' && remoteState.text !== undefined ? remoteState.text : model.body.text;
    const c = model.collapse;
    if (c.mode === 'local' && !expanded && full.length > c.threshold) return `${full.slice(0, c.previewChars)}…`;
    return full;
}

export interface ChatRowShellProps {
    model: ChatRowModel;
    expanded: boolean;
    onToggle?: () => void;
    remoteState?: ToolExpandState;
    onExpandRemote?: (address: ToolExpandAddress) => void;
    onCollapseRemote?: () => void;
    /** Below the body, inside the frame (the queued strip). */
    children?: ReactNode;
}

export function ChatRowShell({ model, expanded, onToggle, remoteState, onExpandRemote, onCollapseRemote, children }: ChatRowShellProps) {
    const { t } = useTranslation('common');
    const kind = model.kind === 'injected' ? 'system' : model.kind;
    const variant = ROW_VARIANTS[kind];
    const label = useRowLabel(model.label);
    const isActivity = model.surface === 'activity';
    const isBubble = !!variant.outer;
    const hasBody = model.body.type === 'parts' || model.body.text.length > 0;
    // A remote expansion counts as open for a local fold too.
    const open = expanded || remoteState?.status === 'expanded';
    const text = resolveDisplayedText(model, open, remoteState);

    // An assistant bubble with nothing to show keeps its alignment row only.
    if (isBubble && !hasBody && model.kind !== 'user') return <div className={variant.outer} />;

    // The inline system row keeps its header inline too (text … time · copy).
    const HeaderTag = variant.headerLast ? 'span' : 'div';
    const header = (
        <HeaderTag
            className={`chat-row-header ${variant.header}${isBubble ? (hasBody ? ' mb-1.5' : ' mb-0') : ''}`}
            aria-label={variant.headerAria ? t(variant.headerAria) : undefined}
        >
            <RowIconView icon={model.icon} />
            {variant.showLabel && <span className={variant.label}>{label}</span>}
            <RowMeta className={variant.meta} copyText={hasBody ? model.copyText : null} timestamp={model.timestamp} />
        </HeaderTag>
    );
    const body = hasBody
        ? <RowBodyView body={model.body} className={variant.body} text={text} asPre={variant.bodyPre} />
        : null;
    const footer = (
        <Collapsible
            collapse={model.collapse}
            className={variant.expand}
            expanded={open}
            onToggle={onToggle}
            remoteState={remoteState}
            onExpandRemote={onExpandRemote}
            onCollapseRemote={onCollapseRemote}
        />
    );

    const frame = (
        <div
            className={`chat-row chat-row-${model.kind} ${variant.root}`}
            data-chat-row-kind={model.kind}
            data-chat-activity-row={isActivity ? 'true' : undefined}
            title={kind === 'system' && model.body.type !== 'parts' ? model.body.text : undefined}
        >
            {!variant.headerLast && header}
            {body}
            {footer}
            {variant.headerLast && header}
            {children}
        </div>
    );
    return variant.outer ? <div className={variant.outer}>{frame}</div> : frame;
}
