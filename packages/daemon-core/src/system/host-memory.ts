/**
 * Host memory metrics — macOS-aware "available" memory.
 *
 * Node's os.freemem() on darwin reports only the tiny truly-free pool; most RAM
 * sits in inactive/file-backed cache that the OS can reclaim. Dashboard "used %"
 * based on (total - freemem) looks ~99% almost always — misleading.
 *
 * On macOS we parse `vm_stat` and approximate available bytes as:
 *   (free + inactive + speculative + purgeable [+ file_backed]) × page size
 * (aligned with common Activity Monitor–style interpretations.)
 */

import * as os from 'os';
import { execSync } from 'child_process';

export interface HostMemorySnapshot {
    totalMem: number;
    /** Raw kernel "free" — small on macOS; kept for debugging / API compat */
    freeMem: number;
    /** Use this for UI "used %" — on darwin from vm_stat; else equals freeMem */
    availableMem: number;
}

function parseDarwinAvailableBytes(totalMem: number): number | null {
    if (os.platform() !== 'darwin') return null;
    try {
        const out = execSync('vm_stat', {
            encoding: 'utf-8',
            timeout: 4000,
            maxBuffer: 256 * 1024,
        });
        const pageSizeMatch = out.match(/page size of (\d+)\s*bytes/i);
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

        const counts: Record<string, number> = {};
        for (const line of out.split('\n')) {
            const m = line.match(/^\s*Pages\s+([^:]+):\s+([\d,]+)\s*\.?/);
            if (!m) continue;
            const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
            const n = parseInt(m[2].replace(/,/g, ''), 10);
            if (!Number.isNaN(n)) counts[key] = n;
        }

        const free = counts['free'] ?? 0;
        const inactive = counts['inactive'] ?? 0;
        const speculative = counts['speculative'] ?? 0;
        const purgeable = counts['purgeable'] ?? 0;
        const fileBacked = counts['file_backed'] ?? 0;

        const availPages = free + inactive + speculative + purgeable + fileBacked;
        const bytes = availPages * pageSize;
        if (!Number.isFinite(bytes) || bytes < 0) return null;
        return Math.min(bytes, totalMem);
    } catch {
        return null;
    }
}

export function getHostMemorySnapshot(): HostMemorySnapshot {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const darwinAvail = parseDarwinAvailableBytes(totalMem);
    const availableMem = darwinAvail != null ? darwinAvail : freeMem;
    return { totalMem, freeMem, availableMem };
}
