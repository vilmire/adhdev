/**
 * bootSessionHost — one session-host bring-up for both hosts
 * (wiring-unification B5, design §B3 "session-host bring-up + PTY factory").
 *
 * Before B5 each host wrote its own copy: cloud started a persistent
 * `SessionHostController` (reconnect + host-event hook) and gave the PTY
 * factory a STABLE client id; standalone used a per-request control plane
 * with no event subscription and a per-pid client id (`daemon-<pid>`), which
 * forced a `force` write re-acquire on every restored session after each
 * daemon restart (session-host-transport.ts `acquire_write` fallback).
 *
 * Winner (D7): the cloud shape for both. Standalone's client id becomes
 * `standalone_<machineId>` — it force-acquires once after this change, then
 * survives restarts. Standalone also gains the host-event hook, so a runtime
 * transition flushes its dashboard's modal / diagnostics topics like cloud.
 *
 * `bootConfig()` is what `DaemonBootConfig.sessionHost` takes.
 */

import type { SessionHostEndpoint, SessionHostEvent } from '@adhdev/session-host-core';
import { SessionHostPtyTransportFactory } from '../cli-adapters/session-host-transport.js';
import type { PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import type { CliTransportFactoryParams, HostedCliRuntimeDescriptor } from '../commands/cli-manager.js';
import type { SessionHostBoot } from '../boot/daemon-components.js';
import { listHostedCliRuntimes } from './runtime-support.js';
import { SessionHostController } from './session-host-controller.js';

export type SessionHostManagedBy = 'adhdev-cloud' | 'adhdev-standalone';

export interface SessionHostBootOptions {
    /** Resolve (spawning when needed) the package's own session host. Re-called by the PTY factory before each spawn. */
    ensureReady(): Promise<SessionHostEndpoint>;
    /** Session-host app name the runtimes are created under (cloud: `resolveSessionHostAppName()`). */
    appName?: string;
    /** Stable write-owner client id = the daemon's status instance id (`daemon_<mid>` / `standalone_<mid>`). */
    clientId: string;
    /** `meta.managedBy` stamp; also the restore filter tag. */
    managedBy: SessionHostManagedBy;
    /** Every host event (after the controller's own logging). */
    onHostEvent?(event: SessionHostEvent): void;
    /** Test seam: the persistent controller (default {@link SessionHostController}). */
    createController?(endpoint: SessionHostEndpoint, onEvent: (event: SessionHostEvent) => void): SessionHostController;
    /** Test seam: list hosted runtimes (default: core `listHostedCliRuntimes`). */
    listHostedRuntimes?(endpoint: SessionHostEndpoint): Promise<HostedCliRuntimeDescriptor[]>;
}

export interface SessionHostHandle {
    /** Last endpoint `ensureReady` resolved. */
    endpoint(): SessionHostEndpoint;
    /** Re-resolve (and remember) the endpoint — respawns a dead host. */
    ensure(): Promise<SessionHostEndpoint>;
    /** The persistent control plane (cloud-shaped for both hosts). */
    readonly control: SessionHostController;
    /** Replaces both hosts' `createPtyTransportFactory` lambdas. */
    ptyFactory(params: CliTransportFactoryParams): PtyTransportFactory;
    listHostedRuntimes(): Promise<HostedCliRuntimeDescriptor[]>;
    /** `DaemonBootConfig.sessionHost`. */
    bootConfig(): SessionHostBoot;
    /** Detach from the host WITHOUT killing it (hosted CLIs outlive the daemon). */
    stop(): Promise<void>;
}

export async function bootSessionHost(opts: SessionHostBootOptions): Promise<SessionHostHandle> {
    let current = await opts.ensureReady();
    const ensure = async (): Promise<SessionHostEndpoint> => {
        current = await opts.ensureReady();
        return current;
    };
    const onEvent = (event: SessionHostEvent) => opts.onHostEvent?.(event);
    const control = opts.createController
        ? opts.createController(current, onEvent)
        : new SessionHostController(current, onEvent);
    await control.start();

    const listHostedRuntimes = () => (opts.listHostedRuntimes ?? listHostedCliRuntimes)(current);
    const ptyFactory = (params: CliTransportFactoryParams): PtyTransportFactory => new SessionHostPtyTransportFactory({
        endpoint: current,
        ensureReady: async () => { await ensure(); },
        clientId: opts.clientId,
        runtimeId: params.runtimeId,
        providerType: params.providerType,
        workspace: params.workspace,
        attachExisting: params.attachExisting,
        ...(opts.appName ? { appName: opts.appName } : {}),
        meta: {
            // Launch-time record meta seeded at create time (SESSION-ACCUMULATION-LEAK
            // defense in depth, CliTransportFactoryParams.initialMeta); the three
            // fields below always win.
            ...(params.initialMeta ?? {}),
            cliArgs: params.cliArgs || [],
            providerSessionId: params.providerSessionId,
            managedBy: opts.managedBy,
        },
    });

    return {
        endpoint: () => current,
        ensure,
        control,
        ptyFactory,
        listHostedRuntimes,
        bootConfig: () => ({
            createPtyTransportFactory: ptyFactory,
            listHostedRuntimes,
            managedByTag: opts.managedBy,
            control,
        }),
        stop: () => control.stop(),
    };
}
