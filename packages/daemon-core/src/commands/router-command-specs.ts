/**
 * Daemon command registry spec assembly — extracted from `./router.ts`
 * (behavior-preserving pure move).
 *
 * Evaluated lazily via `buildDaemonCommandSpecs()` when `getDaemonCommandRegistry()`
 * first builds the registry, preserving the family-module import-cycle invariant.
 */

import type { CommandSpec } from './command-registry.js';
import { handlerSpecs, gitSpecs } from './handler-specs.js';
import { sessionHostSpecs } from './low-family/session-host.js';
import { specProviderDevSpecs } from './low-family/spec-providerdev.js';
import { refineConfigSpecs } from './low-family/refine-config.js';
import { diagnosticsSpecs } from './low-family/diagnostics.js';
import { statusMetaSpecs } from './low-family/status-meta.js';
import { projectTransferSpecs } from './low-family/project-transfer.js';
import { coordinatorPromptSpecs } from './low-family/coordinator-prompt.js';
import { notificationSpecs } from './low-family/notification.js';
import { daemonLifecycleSpecs } from './low-family/daemon-lifecycle.js';
import { quotaReserveSpecs } from './low-family/quota-reserve-commands.js';
import { meshLedgerSpecs } from './low-family/mesh-ledger.js';
import { turnLedgerIpcSpecs } from './low-family/turn-ledger-ipc.js';
import { meshNodeLogsSpecs } from './low-family/mesh-node-logs.js';
import { workerReportSpecs } from './low-family/worker-report.js';
import { workerBridgeSpecs } from './low-family/worker-bridge.js';
import { cooperativeMaintenanceSpecs } from './low-family/cooperative-maintenance.js';
import { maintenanceHoldSpecs } from './low-family/maintenance-hold.js';
import { workerMailboxSpecs } from './low-family/worker-mailbox.js';
import { contractCommandSpecs } from './low-family/contract-commands.js';
import { workerPeerContextSpecs } from './low-family/worker-peer-context.js';
import { transcriptReplicaSpecs } from './low-family/transcript-replica.js';
import { cliAgentSpecs } from './med-family/cli-agent.js';
import { ideSpecs } from './med-family/ide.js';
import { meshCrudSpecs } from './med-family/mesh-crud.js';
import { meshHostPairingSpecs } from './med-family/mesh-host-pairing.js';
import { meshQueueSpecs } from './med-family/mesh-queue.js';
import { fastForwardSpecs } from './med-family/fast-forward.js';
import { meshRestartSpecs } from './med-family/mesh-restart.js';
import { meshOnboardingSpecs } from './med-family/mesh-onboarding.js';
import { meshWorktreeRetentionSpecs } from './med-family/mesh-worktree-retention.js';
import { meshTaskViewCommandSpecs } from './med-family/mesh-task-view-commands.js';
import { meshMissionGitCommandSpecs } from './med-family/mesh-mission-git-commands.js';
import { meshMissionArtifactCommandSpecs } from './med-family/mesh-mission-artifact-commands.js';
import { meshEventsSpecs } from './high-family/mesh-events.js';
import { meshCoordinatorLaunchSpecs } from './high-family/mesh-coordinator-launch.js';
import { meshStatusSpecs } from './high-family/mesh-status.js';
import { meshNodeStateSpecs } from './high-family/mesh-node-state.js';
import { meshStatusViewSpecs } from './high-family/mesh-status-view.js';
import { assistantStoreSpecs } from './high-family/assistant-store.js';
import { driverSpecs } from './med-family/drivers.js';
import { driverAuthoringSpecs } from './med-family/driver-authoring.js';
import { artifactSpecs } from './med-family/artifacts.js';
import { assistantProjectSpecs } from './high-family/assistant.js';
import { assistantDecisionSpecs } from './high-family/assistant-decisions.js';
import { assistantFileTransferSpecs } from './high-family/assistant-file-transfer.js';
import { assistantSessionControlSpecs } from './high-family/assistant-session-control.js';
import { meshHostHandoffSpecs } from './high-family/mesh-host-handoff.js';
import { assistantActionSpecs } from './high-family/assistant-action.js';
import { assistantThreadSpecs } from './high-family/assistant-threads.js';
import { assistantWatchSpecs } from './high-family/assistant-watch.js';
import { missionDecisionSpecs } from './high-family/mission-decisions.js';
import { missionLiveCheckSpecs } from './high-family/mission-live-check.js';
import { meshReleaseSpecs } from './high-family/mesh-release-commands.js';
import { missionDecisionPushRelaySpecs } from './high-family/mission-decision-push-relay.js';
import { assistantRemoteSpecs } from './high-family/assistant-remote.js';
import { assistantLaunchSpecs } from './high-family/assistant-launch.js';
import { launchDefaultsSpecs } from './high-family/launch-defaults.js';

export function buildDaemonCommandSpecs(): CommandSpec[] {
    return [
        ...sessionHostSpecs,
        ...specProviderDevSpecs,
        ...refineConfigSpecs,
        ...diagnosticsSpecs,
        ...statusMetaSpecs,
        ...projectTransferSpecs,
        ...coordinatorPromptSpecs,
        ...notificationSpecs,
        ...daemonLifecycleSpecs,
        ...quotaReserveSpecs,
        ...meshLedgerSpecs,
        ...turnLedgerIpcSpecs,
        ...meshNodeLogsSpecs,
        ...workerReportSpecs,
        ...workerBridgeSpecs,
        ...cooperativeMaintenanceSpecs,
        ...maintenanceHoldSpecs,
        ...workerMailboxSpecs,
        ...contractCommandSpecs,
        ...workerPeerContextSpecs,
        ...transcriptReplicaSpecs,
        ...cliAgentSpecs,
        ...ideSpecs,
        ...meshCrudSpecs,
        ...meshHostPairingSpecs,
        ...meshQueueSpecs,
        ...fastForwardSpecs,
        ...meshRestartSpecs,
        ...meshOnboardingSpecs,
        ...meshWorktreeRetentionSpecs,
        ...meshTaskViewCommandSpecs,
        ...meshMissionGitCommandSpecs,
        ...meshMissionArtifactCommandSpecs,
        ...meshEventsSpecs,
        ...meshCoordinatorLaunchSpecs,
        ...meshStatusSpecs,
        ...meshNodeStateSpecs,
        ...meshStatusViewSpecs,
        ...assistantStoreSpecs,
        ...driverSpecs,
        ...driverAuthoringSpecs,
        ...artifactSpecs,
        ...assistantProjectSpecs,
        ...assistantDecisionSpecs,
        ...assistantFileTransferSpecs,
        ...assistantSessionControlSpecs,
        ...meshHostHandoffSpecs,
        ...assistantActionSpecs,
        ...assistantThreadSpecs,
        ...assistantWatchSpecs,
        ...missionDecisionSpecs,
        ...missionLiveCheckSpecs,
        ...meshReleaseSpecs,
        ...missionDecisionPushRelaySpecs,
        ...assistantRemoteSpecs,
        ...assistantLaunchSpecs,
        ...launchDefaultsSpecs,
        ...handlerSpecs,
        ...gitSpecs,
    ];
}
