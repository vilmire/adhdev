/**
 * Shared helper for forwarding agent stream snapshots into the IDE instance.
 *
 * Both cloud and standalone daemons use the same InstanceManager wiring.
 */
export declare function forwardAgentStreamsToIdeInstance(instanceManager: {
    getInstance: (key: string) => any;
}, ideType: string, streams: any[]): void;
