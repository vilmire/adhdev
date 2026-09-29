/**
 * Post-spawn launch steps of a CLI provider instance: forcing a fresh
 * provider session and applying a runtime-control thinking level.
 *
 * Split out of cli-provider-instance.ts (file-size gate).
 */
import { LOG } from '../logging/logger.js';
import { getCliScriptCommand, parseCliScriptResult } from './cli-script-results.js';
import { getForcedNewSessionScriptName, waitForCliAdapterReady } from './cli-provider-status-helpers.js';
import { antigravityOwnerToken, releaseAntigravityOwner } from './native-history/antigravity-claim-registry.js';
import { releaseTranscriptOwner, transcriptClaimOwnerToken } from './native-history/transcript-claim-registry.js';
import { closeSqliteProbeCache } from './completion/transcript-probe.js';
import type { CliProviderInstance } from './cli-provider-instance.js';
import type { InstanceContext } from './provider-instance.js';
import { isNegativeApprovalLabel } from './approval-utils.js';

/** The CliProviderInstance members these functions read or call (compiler-checked; no cast). */
export type LaunchStepsHost = Pick<CliProviderInstance, 'adapter' | 'applyProviderResponse' | 'initialThinkingLevel' | 'launchMode' | 'provider' | 'type'>;

export async function enforceFreshSessionLaunchIfNeeded(host: LaunchStepsHost): Promise<void> {
    const scriptName = getForcedNewSessionScriptName(host.provider, host.launchMode);
    if (!scriptName) return;

    LOG.info('CLI', `[${host.type}] forcing fresh session launch via script: ${scriptName}`);
    await waitForCliAdapterReady(host.adapter);
    const raw = await host.adapter.invokeScript(scriptName, {});
    const parsed = parseCliScriptResult(raw);
    if (!parsed.success) {
        throw new Error(parsed.payload?.error || `Failed to invoke fresh-session script '${scriptName}'`);
    }

    const cliCommand = getCliScriptCommand(parsed.payload);
    if (cliCommand?.type === 'send_message' && cliCommand.text) {
        await host.adapter.sendMessage(cliCommand.text);
    } else if (cliCommand?.type === 'pty_write' && cliCommand.text) {
        const enterCount = cliCommand.enterCount || 1;
        await host.adapter.writeRaw(cliCommand.text + '\r');
        for (let i = 1; i < enterCount; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 50));
            await host.adapter.writeRaw('\r');
        }
    }

    host.applyProviderResponse(parsed.payload, { phase: 'immediate' });
}

/**
 * BRAIN-ROUTING (runtime-control thinking axis): for a provider that selects
 * reasoning effort via a runtime control instead of a launch arg (e.g. hermes
 * `reasoning`), apply the requested initialThinkingLevel after spawn by invoking
 * that control's setScript. The provider names the control via thinkingControlId.
 * The standard level is mapped through thinkingLevelMap first (same as the
 * launch-arg path). Best-effort: any failure logs and never blocks launch.
 */
export async function applyInitialThinkingLevelViaControl(host: LaunchStepsHost): Promise<void> {
    const level = typeof host.initialThinkingLevel === 'string' ? host.initialThinkingLevel.trim() : '';
    if (!level) return;
    const controlId = (host.provider as any).thinkingControlId;
    if (!controlId) return; // provider uses thinkingLaunchArgs (or has no support)
    const controls: any[] = Array.isArray((host.provider as any).controls) ? (host.provider as any).controls : [];
    const control = controls.find(c => c && c.id === controlId);
    if (!control || !control.setScript) return;
    // Map the standard level to the provider's own vocabulary (unchanged if absent).
    const map = (host.provider as any).thinkingLevelMap as Record<string, string> | undefined;
    const mapped = (map && typeof map[level] === 'string' && map[level].trim()) ? map[level].trim() : level;
    try {
        await waitForCliAdapterReady(host.adapter);
        const raw = await host.adapter.invokeScript(control.setScript, { value: mapped });
        const parsed = parseCliScriptResult(raw);
        if (!parsed.success) {
            LOG.warn('CLI', `[${host.type}] thinking control '${controlId}' set to '${mapped}' failed: ${parsed.payload?.error || 'unknown'}`);
            return;
        }
        const cliCommand = getCliScriptCommand(parsed.payload);
        if (cliCommand?.type === 'send_message' && cliCommand.text) {
            await host.adapter.sendMessage(cliCommand.text);
        } else if (cliCommand?.type === 'pty_write' && cliCommand.text) {
            await host.adapter.writeRaw(cliCommand.text + '\r');
        }
        LOG.info('CLI', `[${host.type}] applied thinking level '${mapped}' via control '${controlId}'`);
    } catch (e: any) {
        LOG.warn('CLI', `[${host.type}] thinking control apply threw: ${e?.message || e}`);
    }
}

/** What wireAdapterCallbacks reads (compiler-checked; no cast). */
export type LifecycleWiringHost = Pick<CliProviderInstance, 'adapter' | 'detectStatusTransition' | 'lifecyclePort' | 'instanceId' | 'pushEvent'>;

/**
 * Register every adapter → instance callback (server conn, PTY output, status
 * change ticks, PTY death / screen signals → lifecycle port, and modal-button
 * resolutions → agent:approval_resolved). Runs once from init(), before spawn.
 */
export function wireAdapterCallbacks(host: LifecycleWiringHost, context: InstanceContext): void {
    // Server connection
    if (context.serverConn) {
        host.adapter.setServerConn(context.serverConn);
    }

    // PTY output callback
    if (context.onPtyData) {
        host.adapter.setOnPtyData(context.onPtyData);
    }

    // Emit event on status change through the cause-carrying hook (B2). The
    // cause-less setOnStatusChange must NOT also be registered — it would tick twice.
    host.adapter.setOnChange((cause) => host.detectStatusTransition(cause));

    // PTY death + screen signals → lifecycle port (wiring-unification B4; replaces
    // the shared termination/signal sinks). `exited` routes through
    // registry.terminate(id, 'pty_exit'), so a racing stop/auto-clean still yields
    // exactly one `terminated`; mesh meaning is applied by bus subscribers.
    host.adapter.setOnExit(({ termination, runtimeSettings }) => {
        host.lifecyclePort?.exited(host.instanceId, termination, runtimeSettings);
    });
    host.adapter.setOnSignal(({ providerType, workspace, runtimeSettings, signal }) => {
        host.lifecyclePort?.signal(host.instanceId, { providerType, workspace, runtimeSettings, signal });
    });

    // APPROVAL-LEVEL-RETRACTION: the adapter is the single point that knows a
    // modal button was actually matched and dispatched. Route that fact through
    // the normal provider-event pipeline so mesh_approve, dashboard/manual
    // resolution, rejection, and worker auto-approve all emit the same durable
    // task_approval_resolved ledger event. A failed/missing button emits nothing.
    host.adapter.setOnApprovalResolved(({ resolvedAt, buttonLabel }) => {
        const resolution = isNegativeApprovalLabel(String(buttonLabel || '')) ? 'rejected' : 'approved';
        host.pushEvent({
            event: 'agent:approval_resolved',
            timestamp: resolvedAt,
            resolution,
            source: 'modal_button',
        });
    });
}

/** The CliProviderInstance members teardown reads or calls (compiler-checked; no cast). */
export type TeardownHost = Pick<CliProviderInstance, 'adapter' | 'antigravityClaimOwner' | 'appliedEffectKeys' | 'autoApproveBusyTimer' | 'autoApproveSettleTimer' | 'clearCancelledCompletionRecheck' | 'completedDebounceTimer' | 'disposed' | 'instanceId' | 'monitor' | 'sqliteProbeCache' | 'startedAt' | 'type' | 'workingDir'>;

/**
 * Owner token for this session in the antigravity conversation-claim
 * registry. Keyed on the daemon instance id — the SAME value the session
 * registry stores as this session's `sessionId` (see cli-manager
 * `sessionRegistry.register({ sessionId: cliInstance.instanceId })`) and the
 * read side hands the dispatcher as `instanceId`. Both sides therefore
 * derive the identical `iid:<instanceId>` token, so the claims the
 * dispatcher records under this session are exactly the ones dispose()
 * releases.
 *
 * This must NOT be derived from a spawn timestamp: the instance's
 * `startedAt`, the adapter's `spawnedAtMs`, and the session registry's
 * `spawnedAtMs` are three INDEPENDENT `Date.now()` samples for the one
 * session, so a workspace+spawn-time token computed here would never equal
 * the read side's — the claim isolation then silently collapses and two
 * concurrent antigravity sessions cross-bind each other's conversation .db
 * (coordinator+worker chat crosswire).
 */
export function antigravityClaimOwner(host: TeardownHost): string {
    return antigravityOwnerToken(host.workingDir, host.startedAt, host.instanceId);
}

export function dispose(host: TeardownHost): void {
    host.disposed = true;
    if (host.completedDebounceTimer) { clearTimeout(host.completedDebounceTimer); host.completedDebounceTimer = null; }
    // Release this session's antigravity conversation claims so the store
    // becomes available again (e.g. a later resume) and the registry doesn't
    // leak entries for dead sessions.
    if (host.type === 'antigravity-cli') {
        const owner = host.antigravityClaimOwner();
        if (owner) releaseAntigravityOwner(owner);
    }
    // Same for kimi's transcript claims (Stage 4): the generalized
    // transcript-claim registry is keyed on the identical iid:<instanceId>
    // owner token, so this session's wire.jsonl claims are released here
    // and a later same-cwd session can claim them immediately instead of
    // waiting on the stale-claim safety net.
    if (host.type === 'kimi') {
        const owner = transcriptClaimOwnerToken(host.instanceId);
        if (owner) releaseTranscriptOwner(owner);
    }
    host.adapter.shutdown();
    host.monitor.reset();
    // Cancel any armed auto-approve timers so a pending settle re-check
    // can't fire resolveModal/detectStatusTransition against a dead adapter.
    if (host.autoApproveSettleTimer) { clearTimeout(host.autoApproveSettleTimer); host.autoApproveSettleTimer = null; }
    if (host.autoApproveBusyTimer) { clearTimeout(host.autoApproveBusyTimer); host.autoApproveBusyTimer = null; }
    // (CANCEL-BLIP-ORPHAN) Same reason: a pending completion recheck must not fire a
    // flush against a shut-down adapter.
    host.clearCancelledCompletionRecheck();
    host.appliedEffectKeys.clear();
    closeSqliteProbeCache(host.sqliteProbeCache);
}
