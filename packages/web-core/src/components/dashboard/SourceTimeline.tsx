/**
 * (A3) SourceTimeline — chronological view of ChatSourceMachine transitions
 * for a single chat pane.
 *
 * Surface for devconsole / debug bundle. Renders nothing when there are no
 * transitions (v1 daemon or pre-A2 subscription).
 *
 * Data shape comes from ChatSourceRegistry.getTransitions() exposed via the
 * daemon's read_chat_debug_bundle command. This component is presentation-
 * only; the controller passes the array down.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

export interface SourceTimelineTransition {
  fromState: string;
  toState: string;
  event: string;
  cause: string;
  at: number;
}

export interface SourceTimelineProps {
  transitions?: ReadonlyArray<SourceTimelineTransition>;
  className?: string;
  /** Optional formatter for the timestamp column. Defaults to ISO string. */
  formatTimestamp?: (at: number) => string;
}

function defaultFormatTimestamp(at: number): string {
  try {
    return new Date(at).toISOString();
  } catch {
    return String(at);
  }
}

function iconForEvent(event: string): string {
  switch (event) {
    case 'NativeProgressed': return '▲';
    case 'NativeRegressed':  return '▽';
    case 'NativeUnavailable': return '×';
    default: return '·';
  }
}

export function SourceTimeline(props: SourceTimelineProps): React.JSX.Element {
  const { t: tl } = useTranslation('common')
  const transitions = props.transitions || [];
  const formatTimestamp = props.formatTimestamp || defaultFormatTimestamp;
  if (transitions.length === 0) {
    return (
      <div className={['source-timeline source-timeline--empty', props.className || ''].filter(Boolean).join(' ')}>
        <em>No source transitions recorded.</em>
      </div>
    );
  }
  return (
    <table className={['source-timeline', props.className || ''].filter(Boolean).join(' ')}>
      <thead>
        <tr>
          <th className="source-timeline-at">{tl('dashboard.sourceTimeline.colWhen')}</th>
          <th className="source-timeline-event">{tl('dashboard.sourceTimeline.colEvent')}</th>
          <th className="source-timeline-from">{tl('dashboard.sourceTimeline.colFrom')}</th>
          <th className="source-timeline-to">{tl('dashboard.sourceTimeline.colTo')}</th>
          <th className="source-timeline-cause">{tl('dashboard.sourceTimeline.colCause')}</th>
        </tr>
      </thead>
      <tbody>
        {transitions.map((t, i) => (
          <tr key={`${t.at}-${i}`} className={`source-timeline-row source-timeline-row--${t.event.toLowerCase()}`}>
            <td className="source-timeline-at">{formatTimestamp(t.at)}</td>
            <td className="source-timeline-event">
              <span className="source-timeline-event-icon">{iconForEvent(t.event)}</span> {t.event}
            </td>
            <td className="source-timeline-from">{t.fromState}</td>
            <td className="source-timeline-to">{t.toState}</td>
            <td className="source-timeline-cause">{t.cause}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default SourceTimeline;
