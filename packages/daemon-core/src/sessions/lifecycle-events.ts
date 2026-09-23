/**
 * lifecycle-events — the typed vocabulary of the SessionLifecycleBus.
 *
 * Wiring-unification Phase B1 (docs/design/2026-09-23-wiring-unification.md §4 B1).
 *
 * Every session fact that more than one subsystem cares about is one member of
 * `SessionLifecycleEvent`; daemon-wide facts that are not about one session's
 * lifecycle are `DaemonEvent`. Subscribers switch exhaustively on `kind`, so a
 * member added later (`input_state` in D, `turn` in C, `launch_updated` in E)
 * is a compile error at every subscriber rather than a silent miss.
 *
 * Output bytes are deliberately NOT on the bus (volume) — see the host output
 * fanout.
 */

import type { SessionStatus } from '@adhdev/mesh-shared';
import type { SessionTermination } from '@adhdev/session-host-core';
import type { InteractivePrompt } from '../providers/types/interactive-prompt.js';
import type { SignalDetection } from '../providers/spec/signal-rules.js';
import type { ProviderEvent, SessionModalState } from '../providers/provider-instance.js';
import type { CommandInvalidationTopic, CommandSource } from '../commands/command-registry.js';
import type { SessionRuntimeTarget } from './registry.js';
import type { SessionLaunchRecord } from './launch-record.js';

/** Which code path put a session into the registry. */
export type RegisterOrigin =
    | 'launch'     // fresh CLI/ACP spawn (cli-manager launch path)
    | 'restore'    // re-attach to a hosted runtime that survived a daemon restart (attachExisting)
    | 'attach'     // CDP attach of an IDE page and its enabled extensions (cdp/setup.ts)
    | 'discover'   // agent-stream poller found a newly enabled extension (agent-stream/poller.ts)
    | 'reconcile'; // defensive repair of a dropped IDE/extension entry (sessions/reconcile.ts)

/** Why a status edge happened — for logs/traces only; subscribers branch on prev/next. */
export type StatusCause =
    | 'fsm_state'          // SpecDriver state_changed (cli-adapter handleEvent)
    | 'pty_exit'           // cli-adapter exit event
    | 'provider_failure'   // latchAuthBillingFailure (status -> error)
    | 'auto_approve_mask'  // status-transition autoApproveActive / autoApproveHoldIdle
    | 'question_picker'    // status-transition question picker -> waiting_choice
    | 'ide_poll'           // ide-provider-instance / extension-provider-instance poll
    | 'acp_update'         // acp-provider-instance session update
    | 'launch'             // initial status of a freshly launched session
    | 'restore';           // initial status of a session re-attached after a daemon restart

/** Why a session left the registry. */
export type TerminationCause =
    | 'pty_exit'           // the PTY child exited (observed by the adapter)
    | 'stop_requested'     // explicit stop/delete/restart from a command
    | 'auto_clean'         // cli-manager auto-clean of a stopped/errored session
    | 'ide_detached'       // CDP connection to the IDE was lost
    | 'ide_stopped'        // stop_ide command
    | 'extension_gone'     // extension disabled / removed from its IDE instance
    | 'daemon_shutdown';   // stamped on every terminate after beginShutdown()

/** Why daemon-wide facts (the `daemon.metadata` projection) changed. */
export type DaemonFactsCause =
    | 'provider_detection'
    | 'provider_channel_sync'
    | 'provider_settings'
    | 'provider_staleness'
    | 'notification_state'
    | 'ide_detached'
    | 'ide_stopped'
    | 'conversation_prefs'
    | 'cli_view_mode'
    /**
     * A command handler reported "daemon facts changed" without naming which
     * (the router's `onStatusChange` dep, shared by several family handlers).
     * The command itself is on the paired `command_executed` event.
     */
    | 'command';

/**
 * Why a session's launch record changed (Phase E). `launch` / `restore` set the
 * whole record; `change_model` is an explicit runtime change (`change_model` /
 * `set_thought_level`); `observed` is the provider reporting what it runs.
 */
export type LaunchUpdateCause = 'launch' | 'restore' | 'change_model' | 'observed';

/** How an interactive prompt was captured. `null` when it was cleared. */
export type PromptTransport = 'tui' | 'stream-json' | 'wire' | null;

/** A provider event as it leaves the instance manager: enriched with its provider type. */
export type EnrichedProviderEvent = ProviderEvent & { providerType: string };

export type SessionLifecycleEvent =
    | {
        kind: 'registered';
        sessionId: string;
        at: number;
        origin: RegisterOrigin;
        session: Readonly<SessionRuntimeTarget>;
    }
    | {
        kind: 'status';
        sessionId: string;
        at: number;
        providerType: string;
        prev: SessionStatus;
        next: SessionStatus;
        cause: StatusCause;
    }
    | { kind: 'modal'; sessionId: string; at: number; modal: SessionModalState | null }
    | { kind: 'prompt'; sessionId: string; at: number; prompt: InteractivePrompt | null; transport: PromptTransport }
    | {
        kind: 'signal';
        sessionId: string;
        at: number;
        providerType?: string;
        workspace?: string;
        runtimeSettings: Readonly<Record<string, unknown>>;
        signal: SignalDetection;
    }
    | { kind: 'binding'; sessionId: string; at: number; providerSessionId: string }
    /** The session's launch provenance (model / thinking / provider) was set or changed. Emitted by the registry only. */
    | {
        kind: 'launch_updated';
        sessionId: string;
        at: number;
        cause: LaunchUpdateCause;
        launch: Readonly<SessionLaunchRecord>;
    }
    | {
        kind: 'terminated';
        sessionId: string;
        at: number;
        cause: TerminationCause;
        providerType: string;
        workspace?: string;
        runtimeSettings: Readonly<Record<string, unknown>>;
        termination?: SessionTermination;
    }
    /**
     * TRANSITIONAL (B -> C): today's untyped agent:* / provider:* / mesh:* event bag,
     * already enriched (providerType, instanceId, targetSessionId, workspaceName).
     * C replaces it with `{kind:'turn'}`; nothing new may subscribe to it after B lands.
     */
    | { kind: 'provider_event'; sessionId: string; at: number; event: EnrichedProviderEvent };

export type DaemonEvent =
    | { kind: 'daemon_facts'; at: number; cause: DaemonFactsCause; sessionId?: string }
    | { kind: 'mesh_state'; at: number; meshId: string }
    | {
        kind: 'command_executed';
        at: number;
        command: string;
        /** `unknown`: the host passed a source string outside {@link CommandSource}. */
        source: CommandSource | 'unknown';
        sessionId?: string;
        success: boolean;
        invalidates: ReadonlySet<CommandInvalidationTopic>;
        fastFlush: boolean;
        postChat: boolean;
        interactionId: string;
    };

export type BusEvent = SessionLifecycleEvent | DaemonEvent;
export type BusEventKind = BusEvent['kind'];
export type EventOf<K extends BusEventKind> = Extract<BusEvent, { kind: K }>;

/** Every kind, for exhaustive iteration (stats tables, tests). */
export const BUS_EVENT_KINDS = [
    'registered',
    'status',
    'modal',
    'prompt',
    'signal',
    'binding',
    'launch_updated',
    'terminated',
    'provider_event',
    'daemon_facts',
    'mesh_state',
    'command_executed',
] as const satisfies readonly BusEventKind[];

/** Fails to compile when a kind is added to the unions but not to BUS_EVENT_KINDS. */
type MissingBusEventKind = Exclude<BusEventKind, typeof BUS_EVENT_KINDS[number]>;
const busEventKindsComplete: [MissingBusEventKind] extends [never] ? true : never = true;
void busEventKindsComplete;

/** Compile-time exhaustiveness guard for `switch (event.kind)` in subscribers. */
export function assertNeverBusEvent(event: never): never {
    throw new Error(`Unhandled bus event: ${JSON.stringify(event)}`);
}
