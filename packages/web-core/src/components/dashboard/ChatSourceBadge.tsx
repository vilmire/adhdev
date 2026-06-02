/**
 * (A3) ChatSourceBadge — single-glance source indicator for a chat pane.
 *
 * Renders the current ChatSourceMachine decision (selected source,
 * fallbackReason if any, lockState) as a small chip. Designed to live
 * next to status / provider label, not as a heavy panel. SourceTimeline
 * is the full debug view; this is the at-a-glance signal.
 *
 * Renders nothing when messageSource is undefined (v1 daemon / pre-A2
 * subscription).
 */

import React from 'react';

export interface ChatSourceBadgeProps {
  messageSource?: Record<string, unknown> | undefined;
  className?: string;
}

interface ParsedMessageSource {
  selected?: 'native-history' | 'pty-parser' | string;
  fallbackReason?: string;
  identityStatus?: string;
  coverage?: { safeMapping?: boolean; nativeMessageCount?: number; ptyMessageCount?: number };
  staleness?: { freshEnough?: boolean };
}

function parse(messageSource: Record<string, unknown> | undefined): ParsedMessageSource | null {
  if (!messageSource || typeof messageSource !== 'object') return null;
  return messageSource as ParsedMessageSource;
}

function shortFallbackLabel(reason: string): string {
  if (reason === 'native_history_not_checked') return 'no check';
  if (reason === 'provider_native_transcript_not_supported') return 'no native';
  if (reason === 'native_history_not_safely_mapped') return 'unsafe map';
  if (reason === 'native_history_partial') return 'partial';
  if (reason === 'native_history_empty') return 'empty';
  if (reason === 'native_history_stale') return 'stale';
  if (reason.startsWith('native_history_unavailable')) return 'unavailable';
  if (reason.startsWith('native_history_source_')) return reason.slice('native_history_source_'.length);
  return reason;
}

export function ChatSourceBadge(props: ChatSourceBadgeProps): React.JSX.Element | null {
  const parsed = parse(props.messageSource);
  if (!parsed) return null;
  const selected = parsed.selected;
  if (selected !== 'native-history' && selected !== 'pty-parser') return null;
  const reason = typeof parsed.fallbackReason === 'string' ? parsed.fallbackReason : '';
  const isNative = selected === 'native-history';
  const className = [
    'chat-source-badge',
    isNative ? 'chat-source-badge--native' : 'chat-source-badge--pty',
    props.className || '',
  ].filter(Boolean).join(' ');
  return (
    <span
      className={className}
      title={buildBadgeTooltip(parsed)}
    >
      <span className="chat-source-badge-label">
        {isNative ? 'native' : 'pty'}
      </span>
      {!isNative && reason ? (
        <span className="chat-source-badge-reason"> {shortFallbackLabel(reason)}</span>
      ) : null}
    </span>
  );
}

function buildBadgeTooltip(parsed: ParsedMessageSource): string {
  const lines: string[] = [];
  lines.push(`source: ${parsed.selected ?? 'unknown'}`);
  if (parsed.fallbackReason) lines.push(`reason: ${parsed.fallbackReason}`);
  if (parsed.identityStatus) lines.push(`identity: ${parsed.identityStatus}`);
  if (parsed.coverage) {
    const safe = parsed.coverage.safeMapping === true ? 'safe' : 'unsafe';
    lines.push(`mapping: ${safe}`);
    if (typeof parsed.coverage.nativeMessageCount === 'number') {
      lines.push(`native msgs: ${parsed.coverage.nativeMessageCount}`);
    }
    if (typeof parsed.coverage.ptyMessageCount === 'number') {
      lines.push(`pty msgs: ${parsed.coverage.ptyMessageCount}`);
    }
  }
  if (parsed.staleness && parsed.staleness.freshEnough !== undefined) {
    lines.push(`locked: ${parsed.staleness.freshEnough ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

export default ChatSourceBadge;
