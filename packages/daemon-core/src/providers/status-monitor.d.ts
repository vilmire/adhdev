/**
 * StatusMonitor — Status monitoring notification system
 *
 * Common across all Provider categories (IDE/Extension/CLI/ACP).
 * - Approval waiting (waiting_approval) notification
 * - No-progress watchdog: alert when an active turn makes no progress for a while
 * - All config toggleable via Provider Settings
 */
export interface MonitorConfig {
    /** Enable awaiting-approval notification */
    approvalAlert: boolean;
    /** No-progress watchdog notification enabled */
    noProgressAlert: boolean;
    /** No-progress threshold (seconds) */
    noProgressThresholdSec: number;
    /** Repeat notification cooldown (seconds) */
    alertCooldownSec: number;
}
export declare const DEFAULT_MONITOR_CONFIG: MonitorConfig;
export interface MonitorEvent {
    type: string;
    agentKey: string;
    timestamp: number;
    elapsedSec?: number;
    message?: string;
}
export declare class StatusMonitor {
    private config;
    private lastAlertTime;
    private generatingStartTimes;
    private noProgressAlerted;
    private lastProgressFingerprint;
    private lastProgressChangeAt;
    constructor(config?: Partial<MonitorConfig>);
    /** Update config (called from Provider Settings) */
    updateConfig(partial: Partial<MonitorConfig>): void;
    /** Return current config */
    getConfig(): MonitorConfig;
    /**
     * Check status transition → return notification event array.
     * Called from each onTick() or detectStatusTransition().
     */
    check(agentKey: string, status: string, now: number, progressFingerprint?: string, approvalPending?: boolean): MonitorEvent[];
    /** Cooldown check — prevent sending the same notification too frequently */
    private shouldAlert;
    /** Reset (on agent terminate/restart) */
    reset(agentKey?: string): void;
}
