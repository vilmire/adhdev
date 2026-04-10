/**
 * ADHDev Launcher — IDE Launch/Relaunch with CDP
 *
 * Launches IDE with Chrome DevTools Protocol (remote-debugging-port).
 * If IDE is already running, terminates it and restarts with CDP option.
 *
 * Pipeline:
 * 1. IDE process detection (already running?)
 * 2. If already running with CDP → reuse as-is
 * 3. If running without CDP → kill process → wait → restart with CDP
 * 4. Not running → start fresh with CDP
 *
 * Usage:
 * adhdev launch — Launch configured IDE with CDP port
 * adhdev launch cursor — Launch Cursor with CDP port
 * adhdev launch --workspace /path — Open specific workspace
 */
/** Kill IDE process (graceful → force) */
export declare function killIdeProcess(ideId: string): Promise<boolean>;
/** Check if IDE process is running */
export declare function isIdeRunning(ideId: string): boolean;
export interface LaunchOptions {
    ideId?: string;
    workspace?: string;
    newWindow?: boolean;
}
export interface LaunchResult {
    success: boolean;
    ideId: string;
    ideName: string;
    port: number;
    action: 'started' | 'restarted' | 'reused' | 'failed';
    message: string;
    error?: string;
}
/**
 * Execute IDE with CDP port (relaunch pipeline)
 *
 * 1. IDE detect
 * 2. per-fixed IDE CDP port determine
 * 3. CDP not active → reuse
 * 4. IDE execute during but CDP none → terminate → restart with CDP
 * 5. IDE not running → start fresh with CDP
 */
export declare function launchWithCdp(options?: LaunchOptions): Promise<LaunchResult>;
export declare function getAvailableIdeIds(): string[];
