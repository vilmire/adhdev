/**
 * Shared helper for forwarding agent stream snapshots into the IDE instance.
 *
 * Both cloud and standalone daemons use the same InstanceManager wiring.
 */

export function forwardAgentStreamsToIdeInstance(
    instanceManager: { getInstance: (key: string) => any },
    ideType: string,
    streams: any[],
): void {
    const ideInstance = instanceManager.getInstance(`ide:${ideType}`) as
        | { onEvent?: (event: string, payload: Record<string, unknown>) => void }
        | undefined;

    if (!ideInstance?.onEvent) return;

    for (const stream of streams) {
        ideInstance.onEvent('stream_update', {
            extensionType: stream.agentType,
            streams: [stream],
            messages: stream.messages || [],
            status: stream.status || 'idle',
            activeModal: stream.activeModal || null,
            model: stream.model || undefined,
            mode: stream.mode || undefined,
        });
    }
}
