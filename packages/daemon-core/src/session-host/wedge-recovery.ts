import * as fs from 'fs';
import * as path from 'path';
import { SessionHostClient, type SessionHostEndpoint } from '@adhdev/session-host-core';
import { hiddenExecFileSync } from '../process/hidden-spawn.js';
import { SESSION_HOST_MAX_OBSERVER_LAG_MS } from './runtime-support.js';
import type { WedgeContext, WedgedHostIdentity, WedgeProbeResult } from './wedged-host-supervisor.js';

const PROBE_TIMEOUT_MS = 5_000;
const CONFIRM_TIMEOUT_MS = 15_000;
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const KEEP_CAPTURES = 5;
const CAPTURE_PREFIX = 'session-host-wedge-';

/**
 * Classifies one isolated diagnostics probe. Only a connected socket whose RPC
 * timed out (or a connect that hangs) is evidence of a wedge; ECONNREFUSED/ENOENT
 * means the host is gone and the ordinary respawn path owns it.
 */
export async function probeHostForWedge(endpoint: SessionHostEndpoint, longTimeout: boolean): Promise<WedgeProbeResult> {
    const timeoutMs = longTimeout ? CONFIRM_TIMEOUT_MS : PROBE_TIMEOUT_MS;
    const client = new SessionHostClient({ endpoint, requestTimeoutMs: timeoutMs, registerAsShared: false });
    const startedAt = performance.now();
    const starved = (): boolean => performance.now() - startedAt - timeoutMs > SESSION_HOST_MAX_OBSERVER_LAG_MS;
    try {
        try {
            await client.connect(timeoutMs);
        } catch (error: any) {
            const code = typeof error?.code === 'string' ? error.code : '';
            if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTSOCK') return 'unreachable';
            if (/timed out|timeout/i.test(String(error?.message))) return starved() ? 'starved' : 'timeout';
            return 'unreachable';
        }
        try {
            const response = await client.request({ type: 'get_host_diagnostics', payload: { includeSessions: false } }, { timeoutMs });
            return response.success ? 'ok' : 'unreachable';
        } catch (error: any) {
            if (error?.code !== 'SESSION_HOST_REQUEST_TIMEOUT') return 'unreachable';
            const lag = typeof error.observerLagMs === 'number' ? error.observerLagMs : 0;
            return lag > SESSION_HOST_MAX_OBSERVER_LAG_MS || starved() ? 'starved' : 'timeout';
        }
    } finally {
        await client.close().catch(() => {});
    }
}

function run(file: string, args: string[], timeout: number): string {
    try {
        return String(hiddenExecFileSync(file, args, {
            encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
        }));
    } catch (error: any) {
        // `sample -mayDie` and lsof exit non-zero on partial output; keep what we got.
        return typeof error?.stdout === 'string' ? error.stdout : `unavailable: ${error?.message || error}`;
    }
}

function summarizeLsof(out: string): string {
    const counts = new Map<string, number>();
    for (const line of out.split('\n').slice(1)) {
        const type = line.trim().split(/\s+/)[4];
        if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts].map(([k, v]) => `${k}=${v}`).sort().join(' ') || 'none';
}

/**
 * Writes one bounded diagnostics file next to the daemon logs: thread/fd
 * summary, a short stack sample (darwin) and the tail of the host log. Contains
 * no environment, no session content. Returns the file path, or undefined.
 */
export async function captureWedgeDiagnostics(
    identity: WedgedHostIdentity,
    context: WedgeContext,
    logDir: string,
    hostLogFile?: string,
): Promise<string | undefined> {
    if (process.platform === 'win32') return undefined;
    const pid = String(identity.pid);
    const lines: string[] = [
        `wedged session host pid=${pid} birth=${identity.birth ?? 'unknown'} streak=${Math.round(context.streakMs / 1000)}s probes=${context.samples}`,
        `captured_at=${new Date().toISOString()}`,
    ];
    const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
    lines.push(`fd_types: ${summarizeLsof(run(lsof, ['-n', '-p', pid], 8_000))}`);
    lines.push(`process: ${run('/bin/ps', ['-o', 'pid=,etime=,rss=,state=,nlwp=', '-p', pid], 3_000).trim()}`);
    if (process.platform === 'darwin') {
        lines.push(`threads: ${run('/bin/ps', ['-M', '-p', pid], 3_000).trim().split('\n').length - 1}`);
        lines.push('--- sample ---', run('/usr/bin/sample', [pid, '2', '-mayDie'], 15_000).slice(0, 200_000));
    } else {
        lines.push(`status: ${run('/bin/cat', [`/proc/${pid}/status`], 2_000).split('\n').filter((l) => /^(Threads|VmRSS|State)/.test(l)).join(' ')}`);
    }
    if (hostLogFile) {
        try {
            const stat = fs.statSync(hostLogFile);
            const fd = fs.openSync(hostLogFile, 'r');
            try {
                const length = Math.min(stat.size, MAX_LOG_TAIL_BYTES);
                const buffer = Buffer.alloc(length);
                fs.readSync(fd, buffer, 0, length, stat.size - length);
                lines.push('--- host log tail ---', buffer.toString('utf8'));
            } finally { fs.closeSync(fd); }
        } catch { /* log may not exist */ }
    }
    try {
        fs.mkdirSync(logDir, { recursive: true });
        const file = path.join(logDir, `${CAPTURE_PREFIX}${Date.now()}-${pid}.txt`);
        fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
        const old = fs.readdirSync(logDir).filter((n) => n.startsWith(CAPTURE_PREFIX)).sort();
        for (const name of old.slice(0, Math.max(0, old.length - KEEP_CAPTURES))) {
            try { fs.unlinkSync(path.join(logDir, name)); } catch { /* best-effort */ }
        }
        return file;
    } catch {
        return undefined;
    }
}
