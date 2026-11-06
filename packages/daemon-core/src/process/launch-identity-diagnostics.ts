/**
 * What a failed CLI start knew about the account it ran as. A `uv_os_get_passwd` failure looks
 * like a login problem but is a local account lookup, so the two must be tellable apart afterwards.
 * Safe metadata only: no paths, names or environment values.
 */
import * as fs from 'fs';
import * as os from 'os';

export function describeLaunchIdentity(extraEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env, userInfo: () => unknown = () => os.userInfo()): string {
    let passwd = 'ok';
    try { userInfo(); } catch (e: any) { passwd = String(e?.code ?? 'failed'); }
    const home = extraEnv?.HOME ?? env.HOME;
    let homeState = 'unset';
    if (home) {
        try { homeState = fs.statSync(home).isDirectory() ? 'dir' : 'not_dir'; } catch { homeState = 'missing'; }
    }
    return `uid=${process.getuid?.() ?? 'n/a'} passwd=${passwd} home=${homeState} privateHome=${extraEnv?.HOME ? 'yes' : 'no'}`;
}
