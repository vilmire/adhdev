/**
 * (B4) CoordinatorIdentityBadge — at-a-glance indicator showing which
 * coordinator daemon a mesh node belongs to.
 *
 * The audit's prerequisite for using multiple coordinators safely was
 * making the routing visible. v1 mesh UI had no per-node coordinator
 * identity; users could not tell whether a node belonged to coordinator A
 * or coordinator B. With v2 routing (B2/B3), the daemonId + coordinatorRunId
 * tuple is meaningful and should be surfaced.
 *
 * Render nothing when the node has no coordinator association (legacy
 * unmanaged nodes, pre-v2 mesh data).
 */

import React from 'react';

export interface CoordinatorIdentityBadgeProps {
  /** Coordinator daemon id (machineId of the host daemon). */
  daemonId?: string | null;
  /** Optional run id; renders in the tooltip but not the chip body. */
  coordinatorRunId?: string | null;
  /** Optional CLI session id when the coordinator is a CLI session. */
  sessionId?: string | null;
  /** Human-readable label override; defaults to short daemonId. */
  label?: string;
  /** When true, render an alert variant indicating the user should pay attention. */
  warning?: boolean;
  className?: string;
}

function shortDaemonId(daemonId: string): string {
  if (daemonId.length <= 10) return daemonId;
  return `${daemonId.slice(0, 8)}…`;
}

export function CoordinatorIdentityBadge(props: CoordinatorIdentityBadgeProps): React.JSX.Element | null {
  const daemonId = typeof props.daemonId === 'string' ? props.daemonId.trim() : '';
  if (!daemonId) return null;
  const label = props.label ?? shortDaemonId(daemonId);
  const tooltipLines: string[] = [
    `daemon: ${daemonId}`,
  ];
  if (props.coordinatorRunId) tooltipLines.push(`run: ${props.coordinatorRunId}`);
  if (props.sessionId) tooltipLines.push(`session: ${props.sessionId}`);
  const className = [
    'coordinator-identity-badge',
    props.warning ? 'coordinator-identity-badge--warning' : '',
    props.className || '',
  ].filter(Boolean).join(' ');
  return (
    <span className={className} title={tooltipLines.join('\n')}>
      <span className="coordinator-identity-badge-icon">●</span>
      <span className="coordinator-identity-badge-label">{label}</span>
    </span>
  );
}

export default CoordinatorIdentityBadge;
