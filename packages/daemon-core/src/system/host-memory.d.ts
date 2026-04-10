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
export interface HostMemorySnapshot {
    totalMem: number;
    /** Raw kernel "free" — small on macOS; kept for debugging / API compat */
    freeMem: number;
    /** Use this for UI "used %" — on darwin from vm_stat; else equals freeMem */
    availableMem: number;
}
export declare function getHostMemorySnapshot(): HostMemorySnapshot;
