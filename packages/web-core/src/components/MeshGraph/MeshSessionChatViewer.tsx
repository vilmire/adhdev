/**
 * (B4) MeshSessionChatViewer — read-only chat view for a mesh coordinator
 * session.
 *
 * Surfaces the mesh_read_chat output (or any equivalent shaped payload).
 * Used by the mesh inspection panel to show what a coordinator session
 * is actually saying without leaving the mesh view. Read-only: send is
 * not exposed here.
 *
 * Filters runtime_status / control / provider_chrome messages by default
 * to comply with CLAUDE.md's "internal tool/status/control/debug messages
 * must not be shown as ordinary user-visible chat transcript content".
 * Toggle via showInternal.
 */

import React from 'react';

export interface MeshSessionChatMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  kind?: string;
  source?: string;
  receivedAt?: number;
  senderName?: string;
}

export interface MeshSessionChatViewerProps {
  messages: ReadonlyArray<MeshSessionChatMessage> | undefined;
  loading?: boolean;
  error?: string | null;
  showInternal?: boolean;
  emptyLabel?: string;
  className?: string;
}

const INTERNAL_SOURCES = new Set(['runtime_status', 'provider_chrome', 'control']);

function isUserFacingMessage(message: MeshSessionChatMessage, showInternal: boolean): boolean {
  if (showInternal) return true;
  if (message.source && INTERNAL_SOURCES.has(message.source)) return false;
  if (message.kind === 'system') return false;
  return true;
}

function flattenContent(content: MeshSessionChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function formatTimestamp(at?: number): string {
  if (!at || !Number.isFinite(at)) return '';
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return '';
  }
}

export function MeshSessionChatViewer(props: MeshSessionChatViewerProps): React.JSX.Element {
  const baseClass = ['mesh-session-chat-viewer', props.className || ''].filter(Boolean).join(' ');
  if (props.loading) {
    return <div className={`${baseClass} mesh-session-chat-viewer--loading`}>Loading…</div>;
  }
  if (props.error) {
    return <div className={`${baseClass} mesh-session-chat-viewer--error`}>{props.error}</div>;
  }
  const messages = props.messages ?? [];
  const showInternal = props.showInternal === true;
  const visible = messages.filter(m => isUserFacingMessage(m, showInternal));
  if (visible.length === 0) {
    return <div className={`${baseClass} mesh-session-chat-viewer--empty`}><em>{props.emptyLabel ?? 'No messages.'}</em></div>;
  }
  return (
    <ol className={baseClass}>
      {visible.map((message, i) => {
        const text = flattenContent(message.content);
        const role = message.role || 'assistant';
        const ts = formatTimestamp(message.receivedAt);
        const className = [
          'mesh-session-chat-message',
          `mesh-session-chat-message--${role}`,
          message.kind ? `mesh-session-chat-message--kind-${message.kind}` : '',
        ].filter(Boolean).join(' ');
        return (
          <li key={i} className={className}>
            <div className="mesh-session-chat-message-meta">
              <span className="mesh-session-chat-message-role">{role}</span>
              {message.senderName ? <span className="mesh-session-chat-message-sender"> ({message.senderName})</span> : null}
              {ts ? <span className="mesh-session-chat-message-time">{ts}</span> : null}
            </div>
            {text ? <div className="mesh-session-chat-message-text">{text}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

export default MeshSessionChatViewer;
