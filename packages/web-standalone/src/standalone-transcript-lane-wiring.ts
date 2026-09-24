/**
 * Real assembly of the standalone transcript replica lane — the injected
 * dependencies of `StandaloneTranscriptLaneClient` bound to web-core and the
 * browser (twin of web-cloud's `transcript-worker-transport.ts`).
 *
 * The `new Worker(new URL(...), { type: 'module' })` construct lives HERE
 * because Vite must see that literal statically to emit the worker chunk;
 * web-core stays bundler-agnostic and takes it as `createWorker`.
 *
 * COOP/COEP is not required (see the note in web-cloud's
 * `transcript-worker-transport.ts`): the OPFS SAH pool VFS does not use
 * SharedArrayBuffer.
 */
import {
    applyTranscriptReplicaSnapshotToControllers,
    collectRetainedTranscriptSessionInterest,
    reportTranscriptReplicaFallbackForSession,
    subscribeTranscriptSessionInterest,
} from '@adhdev/web-core'
import { startTranscriptWorkerHost } from '@adhdev/web-core/transcript-transport'
import { getStandaloneToken } from './standalone-auth-client'
import {
    STANDALONE_TRANSCRIPT_WRITER_ID,
    StandaloneTranscriptLaneClient,
    buildStandaloneSeqscribeWsUrl,
    isStandaloneTranscriptLaneEnabled,
} from './standalone-transcript-lane'

/**
 * Start the lane for this page. Returns a stop function (idempotent), or a
 * no-op when the lane is switched off or the browser cannot run the worker.
 */
export function startStandaloneTranscriptLane(): () => void {
    if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof WebSocket === 'undefined') {
        return () => undefined
    }
    if (!isStandaloneTranscriptLaneEnabled(import.meta.env as Record<string, unknown>)) return () => undefined

    const url = buildStandaloneSeqscribeWsUrl(window.location, getStandaloneToken())
    const client = new StandaloneTranscriptLaneClient({
        createSocket: () => new WebSocket(url),
        startHost: (transport, onSnapshot) =>
            startTranscriptWorkerHost(transport, {
                writerId: STANDALONE_TRANSCRIPT_WRITER_ID,
                // One database per origin; each session is its own seqscribe
                // TOPIC inside it (same rationale as web-cloud).
                sessionKey: 'transcript',
                onSnapshot,
                createWorker: () =>
                    new Worker(
                        new URL('@adhdev/web-core/transcript-transport/worker-entry', import.meta.url),
                        { type: 'module' },
                    ),
                onOverflow: () => console.warn('[Transcript] standalone lane pre-open queue overflow — channel reset'),
            }),
        collectInterest: collectRetainedTranscriptSessionInterest,
        subscribeInterest: subscribeTranscriptSessionInterest,
        applySnapshot: applyTranscriptReplicaSnapshotToControllers,
        reportFallback: reportTranscriptReplicaFallbackForSession,
        setTimer: (cb, ms) => setTimeout(cb, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        log: (message) => console.warn(message),
    })
    client.start()
    return () => client.stop()
}
