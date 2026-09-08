/**
 * Probe whether a pid is still running.
 *
 * `process.kill(pid, 0)` sends no signal — it only performs the permission and
 * existence check. `EPERM` means the process exists but belongs to another
 * user, which still counts as alive; anything else (notably `ESRCH`) means it
 * is gone.
 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}
