/**
 * A delegated kimi worker runs under a private KIMI_CODE_HOME. The pre-launch
 * trust grant used to follow only the daemon's env, so it landed in the owner's
 * ~/.kimi-code; the worker then showed kimi's folder-trust prompt and the task
 * message was typed into it and lost (2026-10-05 provider matrix, claude→kimi).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applySpecPreLaunchTrust } from '../../../src/providers/spec/fsm-driver-launch.js';

const tmp: string[] = [];
function mkd(prefix: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmp.push(d); return d; }
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('applySpecPreLaunchTrust — kimi_workspace_file', () => {
    it('writes the grant into the launch env KIMI_CODE_HOME, not the daemon home', () => {
        const workerHome = mkd('kimi-worker-home-');
        const ws = mkd('kimi-ws-');
        const spec: any = { pre_launch_trust: { scheme: 'kimi_workspace_file' } };
        applySpecPreLaunchTrust(spec, { workingDir: ws, extraEnv: { KIMI_CODE_HOME: workerHome } } as any, 'kimi/test');
        const grants = fs.readdirSync(path.join(workerHome, 'workspace-trust'));
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatch(/^wd_kimi-ws-/);
    });
});
