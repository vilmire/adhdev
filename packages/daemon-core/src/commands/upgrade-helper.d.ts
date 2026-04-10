export interface DaemonUpgradeHelperPayload {
    packageName: string;
    targetVersion: string;
    parentPid: number;
    restartArgv: string[];
    cwd?: string;
    sessionHostAppName?: string;
}
export declare function spawnDetachedDaemonUpgradeHelper(payload: DaemonUpgradeHelperPayload): void;
export declare function maybeRunDaemonUpgradeHelperFromEnv(): Promise<boolean>;
