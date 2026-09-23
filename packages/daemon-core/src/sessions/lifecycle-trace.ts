/**
 * lifecycle-trace — one DEBUG log line per session-lifecycle bus event.
 *
 * The bus itself is silent by design (subscribers own their side effects), which
 * made the Phase B live checklist unobservable from the daemon log: `registered`,
 * `terminated`, `status`, `command_executed` left no trace. This subscriber is
 * the greppable proof for live verification and for field diagnosis
 * (grep the daemon log for `[bus]`).
 *
 * Content boundary: every line is scalars only — identifiers, enums, booleans,
 * counters. Modal/prompt text, summaries and provider payloads are never logged.
 */
import type { SessionLifecycleBus, Unsubscribe } from './lifecycle-bus.js';
import type { BusEvent } from './lifecycle-events.js';

export type LifecycleTraceLog = (line: string) => void;

const SESSION_ID_LEN = 8;

function short(id: string | undefined | null): string {
    if (!id) return '-';
    return id.length > SESSION_ID_LEN + 2 ? `${id.slice(0, SESSION_ID_LEN)}…` : id;
}

/** Render a bus event as a content-free, single-line trace. Exported for tests. */
export function formatLifecycleTraceLine(event: BusEvent): string {
    switch (event.kind) {
        case 'registered':
            return `[bus] registered session=${short(event.sessionId)} origin=${event.origin} provider=${event.session.providerType ?? '-'} transport=${event.session.transport ?? '-'}`;
        case 'status':
            return `[bus] status session=${short(event.sessionId)} ${event.prev}→${event.next} cause=${event.cause} provider=${event.providerType}`;
        case 'modal':
            return `[bus] modal session=${short(event.sessionId)} present=${event.modal ? 'yes' : 'no'} active=${event.modal?.activeModal ? 'yes' : 'no'}`;
        case 'prompt':
            return `[bus] prompt session=${short(event.sessionId)} present=${event.prompt ? 'yes' : 'no'} transport=${event.transport}`;
        case 'signal':
            return `[bus] signal session=${short(event.sessionId)} kind=${String((event.signal as { kind?: unknown } | null)?.kind ?? 'unknown')}`;
        case 'binding':
            return `[bus] binding session=${short(event.sessionId)} providerSession=${short(event.providerSessionId)}`;
        case 'launch_updated':
            return `[bus] launch_updated session=${short(event.sessionId)} cause=${event.cause} model=${event.launch.model.source}`;
        case 'terminated':
            return `[bus] terminated session=${short(event.sessionId)} cause=${event.cause} provider=${event.providerType}`;
        case 'provider_event':
            return `[bus] provider_event session=${short(event.sessionId)} event=${String((event.event as { event?: unknown }).event ?? 'unknown')}`;
        case 'daemon_facts':
            return `[bus] daemon_facts cause=${event.cause}${event.sessionId ? ` session=${short(event.sessionId)}` : ''}`;
        case 'mesh_state':
            return `[bus] mesh_state mesh=${short(event.meshId)}`;
        case 'command_executed':
            return `[bus] command_executed cmd=${event.command} src=${event.source} ok=${event.success} invalidates=${event.invalidates.size} fastFlush=${event.fastFlush} postChat=${event.postChat}${event.sessionId ? ` session=${short(event.sessionId)}` : ''}`;
        default: {
            const never: never = event;
            return `[bus] ${String((never as { kind?: unknown }).kind)}`;
        }
    }
}

/**
 * Subscribe a DEBUG tracer to every bus event. Returns the unsubscribe handle;
 * the caller (boot) disposes it with the session core.
 */
export function subscribeLifecycleTrace(
    bus: SessionLifecycleBus,
    log: LifecycleTraceLog,
    /** Level gate, checked BEFORE formatting — the logger filters after the string exists. */
    isEnabled: () => boolean = () => true,
): Unsubscribe {
    return bus.on('*', (event) => {
        if (!isEnabled()) return;
        log(formatLifecycleTraceLine(event));
    }, { name: 'lifecycle.trace' });
}
