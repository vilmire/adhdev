import type { PtySpawnOptions, PtyRuntimeTransport } from './pty-transport.js';
import type { TerminalScreen } from './terminal-screen.js';
import { type CliProviderModule } from './provider-cli-shared.js';
export interface CliSpawnPlan {
    binaryPath: string;
    allArgs: string[];
    shellCmd: string;
    shellArgs: string[];
    ptyOptions: PtySpawnOptions;
    isWin: boolean;
    useShell: boolean;
}
export declare function resolveCliSpawnPlan(options: {
    provider: CliProviderModule;
    runtimeSettings: Record<string, any>;
    workingDir: string;
    extraArgs: string[];
}): CliSpawnPlan;
export declare function buildCliLoginShellRetry(plan: Pick<CliSpawnPlan, 'binaryPath' | 'allArgs'>): {
    shellCmd: string;
    shellArgs: string[];
};
export declare function getCliSpawnErrorHint(message: string, shellCmd: string, isWin: boolean): string | null;
export declare function respondToCliTerminalQueries(options: {
    ptyProcess: PtyRuntimeTransport | null;
    pendingTail: string;
    data: string;
    terminalScreen: TerminalScreen;
}): string;
