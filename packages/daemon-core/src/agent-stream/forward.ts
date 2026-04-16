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
        | {
            onEvent?: (event: string, payload?: Record<string, unknown>) => void;
            getExtensionTypes?: () => string[];
        }
        | undefined;

    if (!ideInstance?.onEvent) return;

    const seenExtensionTypes = new Set<string>();

    for (const stream of streams) {
        if (typeof stream.agentType === 'string' && stream.agentType) {
            seenExtensionTypes.add(stream.agentType);
        }
        ideInstance.onEvent('stream_update', {
            extensionType: stream.agentType,
            streams: [stream],
            messages: stream.messages || [],
            status: stream.status || 'idle',
            activeModal: stream.activeModal || null,
            controlValues: stream.controlValues || undefined,
            summaryMetadata: stream.summaryMetadata || undefined,
            effects: stream.effects || undefined,
            sessionId: stream.sessionId || stream.instanceId || undefined,
            providerSessionId: stream.providerSessionId || stream.sessionId || undefined,
            title: stream.title || stream.agentName || undefined,
            agentType: stream.agentType || undefined,
            agentName: stream.agentName || undefined,
            extensionId: stream.extensionId || undefined,
            inputContent: stream.inputContent || '',
        });
    }

    const extensionTypes = ideInstance.getExtensionTypes?.() || [];
    if (streams.length === 0) {
        ideInstance.onEvent('stream_reset_all');
        return;
    }

    for (const extensionType of extensionTypes) {
        if (!seenExtensionTypes.has(extensionType)) {
            ideInstance.onEvent('stream_reset', { extensionType });
        }
    }
}
