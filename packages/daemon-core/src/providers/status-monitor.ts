/**
 * StatusMonitor — Status monitoring notification system
 *
 * Common across all Provider categories (IDE/Extension/CLI/ACP).
 * - Approval waiting (waiting_approval) notification
 * - Notification when generating persists for extended duration
 * - All config toggleable via Provider Settings
 */

export interface MonitorConfig {
 /** Enable awaiting-approval notification */
    approvalAlert: boolean;
 /** Prolonged generating notification enabled */
    longGeneratingAlert: boolean;
 /** Prolonged threshold (seconds) */
    longGeneratingThresholdSec: number;
 /** Repeat notification cooldown (seconds) */
    alertCooldownSec: number;
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
    approvalAlert: true,
    longGeneratingAlert: true,
    longGeneratingThresholdSec: 180,   // 3 minutes
    alertCooldownSec: 60,              // 1 minute cooldown
};

export interface MonitorEvent {
    type: string;
    agentKey: string;
    timestamp: number;
    elapsedSec?: number;
    message?: string;
}

export class StatusMonitor {
    private config: MonitorConfig;
    private lastAlertTime = new Map<string, number>();
    private generatingStartTimes = new Map<string, number>();
    private longGeneratingAlerted = new Map<string, boolean>();
    private lastProgressFingerprint = new Map<string, string>();
    private lastProgressChangeAt = new Map<string, number>();

    constructor(config?: Partial<MonitorConfig>) {
        this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
    }

 /** Update config (called from Provider Settings) */
    updateConfig(partial: Partial<MonitorConfig>): void {
        Object.assign(this.config, partial);
    }

 /** Return current config */
    getConfig(): MonitorConfig {
        return { ...this.config };
    }

 /**
  * Check status transition → return notification event array.
  * Called from each onTick() or detectStatusTransition().
  */
    check(agentKey: string, status: string, now: number, progressFingerprint?: string): MonitorEvent[] {
        const events: MonitorEvent[] = [];

 // 1. Approval waiting notification
        if (this.config.approvalAlert && status === 'waiting_approval') {
            if (this.shouldAlert(agentKey + ':approval', now)) {
                events.push({
                    type: 'monitor:approval_waiting',
                    agentKey,
                    timestamp: now,
                    message: `${agentKey} is waiting for approval`,
                });
            }
        }

 // 2. Detect prolonged generating (identical for IDE/Extension/CLI/ACP)
        if (status === 'generating' || status === 'streaming') {
            if (!this.generatingStartTimes.has(agentKey)) {
                this.generatingStartTimes.set(agentKey, now);
                this.longGeneratingAlerted.set(agentKey, false);
                const initialFingerprint = progressFingerprint ?? '';
                this.lastProgressFingerprint.set(agentKey, initialFingerprint);
                this.lastProgressChangeAt.set(agentKey, now);
            }
            const currentFingerprint = progressFingerprint ?? '';
            const previousFingerprint = this.lastProgressFingerprint.get(agentKey);
            if (previousFingerprint !== currentFingerprint) {
                this.lastProgressFingerprint.set(agentKey, currentFingerprint);
                this.lastProgressChangeAt.set(agentKey, now);
                this.longGeneratingAlerted.set(agentKey, false);
            }
            if (this.config.longGeneratingAlert) {
                const progressChangedAt = this.lastProgressChangeAt.get(agentKey) || this.generatingStartTimes.get(agentKey)!;
                const elapsedSec = Math.round((now - progressChangedAt) / 1000);
                const alreadyAlerted = this.longGeneratingAlerted.get(agentKey) === true;
                if (elapsedSec > this.config.longGeneratingThresholdSec && !alreadyAlerted) {
                    if (this.shouldAlert(agentKey + ':long_gen', now)) {
                        this.longGeneratingAlerted.set(agentKey, true);
                        events.push({
                            type: 'monitor:long_generating',
                            agentKey,
                            elapsedSec,
                            timestamp: now,
                            message: `${agentKey} output appears stuck for ${Math.round(elapsedSec / 60)}min`,
                        });
                    }
                }
            }
        } else {
 // Reset timer when switching to non-generating status
            this.generatingStartTimes.delete(agentKey);
            this.longGeneratingAlerted.delete(agentKey);
            this.lastProgressFingerprint.delete(agentKey);
            this.lastProgressChangeAt.delete(agentKey);
        }

        return events;
    }

 /** Cooldown check — prevent sending the same notification too frequently */
    private shouldAlert(key: string, now: number): boolean {
        const last = this.lastAlertTime.get(key) || 0;
        if (now - last > this.config.alertCooldownSec * 1000) {
            this.lastAlertTime.set(key, now);
            return true;
        }
        return false;
    }

 /** Reset (on agent terminate/restart) */
    reset(agentKey?: string): void {
        if (agentKey) {
            this.generatingStartTimes.delete(agentKey);
            this.longGeneratingAlerted.delete(agentKey);
            this.lastProgressFingerprint.delete(agentKey);
            this.lastProgressChangeAt.delete(agentKey);
 // Delete all cooldowns for this key
            for (const k of this.lastAlertTime.keys()) {
                if (k.startsWith(agentKey)) this.lastAlertTime.delete(k);
            }
        } else {
            this.generatingStartTimes.clear();
            this.longGeneratingAlerted.clear();
            this.lastProgressFingerprint.clear();
            this.lastProgressChangeAt.clear();
            this.lastAlertTime.clear();
        }
    }
}
