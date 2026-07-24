export interface DaemonUpgradeHelperPayload {
    packageName: string;
    targetVersion: string;
    parentPid: number;
    restartArgv: string[];
    cwd?: string;
    sessionHostAppName?: string;
}
export interface CurrentGlobalInstallSurface {
    npmExecutable: string;
    npmArgsPrefix?: string[];
    packageRoot: string | null;
    installPrefix: string | null;
    execOptions?: { shell: boolean };
}
export interface PinnedGlobalInstallCommand {
    command: string;
    args: string[];
    surface: CurrentGlobalInstallSurface;
    execOptions: { shell: boolean };
}
export declare function resolveInstanceDir(configDir?: string): string;
export declare function resolveCurrentGlobalInstallSurface(options: {
    packageName: string;
    currentCliPath?: string;
    nodeExecutable?: string;
    platform?: NodeJS.Platform;
    homeDir?: string;
    instanceDir?: string;
}): CurrentGlobalInstallSurface;
export declare function buildPinnedGlobalInstallCommand(options: {
    packageName: string;
    targetVersion: string;
    currentCliPath?: string;
    nodeExecutable?: string;
    platform?: NodeJS.Platform;
}): PinnedGlobalInstallCommand;
export declare function spawnDetachedDaemonUpgradeHelper(payload: DaemonUpgradeHelperPayload): void;
export declare function maybeRunDaemonUpgradeHelperFromEnv(): Promise<boolean>;
