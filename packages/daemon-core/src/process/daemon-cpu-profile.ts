/**
 * What is holding this daemon's event loop, measured from inside the process over
 * `node:inspector`. A log line says the loop stalled; only a sample says which code did it,
 * and a host daemon has to answer that without anyone opening a terminal on its machine.
 * The result carries function names and code locations, never arguments or data.
 */

export const MAX_PROFILE_SECONDS = 25;
const SAMPLE_INTERVAL_US = 2_000;
const STALL_MS = 1_000;
const MAX_STALLS = 5;
const STACK_DEPTH = 14;

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
export interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
export interface TimedFrame { ms: number; frame: string }
export interface CpuProfileSummary {
    sampledMs: number; busyMs: number; gcMs: number; idleMs: number;
    /** Unbroken stretches without an idle sample, longest first. */
    stalls: Array<{ ms: number; stacks: Array<{ ms: number; stack: string[] }> }>;
    topSelf: TimedFrame[];
    topInclusive: TimedFrame[];
}

const frameLabel = (n: ProfileNode): string => {
    const f = n.callFrame;
    const file = f.url ? f.url.replace(/^file:\/\//, '').split('/').slice(-2).join('/') : '';
    return `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
};
const ranked = (m: Map<string, number>, limit: number): TimedFrame[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([frame, ms]) => ({ frame, ms: Math.round(ms) }));

export function summarizeCpuProfile(profile: CpuProfile): CpuProfileSummary {
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id);
    const stackOf = (id: number): string[] => {
        const frames: string[] = [];
        for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
            const n = byId.get(at);
            if (n && n.callFrame.functionName !== '(root)') frames.push(frameLabel(n));
        }
        return frames;
    };
    const self = new Map<string, number>(), inclusive = new Map<string, number>();
    const stalls: Array<{ ms: number; stacks: Map<string, number> }> = [];
    let busyMs = 0, gcMs = 0, idleMs = 0;
    let run: { ms: number; stacks: Map<string, number> } | null = null;
    const closeRun = () => { if (run && run.ms >= STALL_MS) stalls.push(run); run = null; };
    profile.samples.forEach((id, i) => {
        const ms = (profile.timeDeltas[i] ?? 0) / 1000;
        const name = byId.get(id)?.callFrame.functionName ?? '';
        if (name === '(idle)') { idleMs += ms; closeRun(); return; }
        run ??= { ms: 0, stacks: new Map() };
        run.ms += ms;
        if (name === '(garbage collector)') { gcMs += ms; return; }
        if (name === '(program)') return;
        busyMs += ms;
        const stack = stackOf(id);
        self.set(stack[0]!, (self.get(stack[0]!) ?? 0) + ms);
        for (const frame of new Set(stack)) inclusive.set(frame, (inclusive.get(frame) ?? 0) + ms);
        const key = stack.slice(0, STACK_DEPTH).join('\n');
        run.stacks.set(key, (run.stacks.get(key) ?? 0) + ms);
    });
    closeRun();
    return {
        sampledMs: Math.round((profile.endTime - profile.startTime) / 1000),
        busyMs: Math.round(busyMs), gcMs: Math.round(gcMs), idleMs: Math.round(idleMs),
        stalls: stalls.sort((a, b) => b.ms - a.ms).slice(0, MAX_STALLS).map(s => ({
            ms: Math.round(s.ms),
            stacks: [...s.stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([stack, ms]) => ({ ms: Math.round(ms), stack: stack.split('\n') })),
        })),
        topSelf: ranked(self, 20),
        topInclusive: ranked(inclusive, 30),
    };
}

let capturing = false;

/** One capture at a time: the sampler is process-wide. */
export async function captureDaemonCpuProfile(seconds: number): Promise<CpuProfileSummary> {
    if (capturing) throw new Error('cpu_profile_in_progress');
    capturing = true;
    const { Session } = await import('node:inspector');
    const session = new Session();
    try {
        session.connect();
        const post = <T>(method: string, params?: object) => new Promise<T>((resolve, reject) => {
            (session.post as (m: string, p: object, cb: (e: Error | null, r: T) => void) => void)(method, params ?? {}, (e, r) => e ? reject(e) : resolve(r));
        });
        await post('Profiler.enable');
        await post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US });
        await post('Profiler.start');
        await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(seconds, 1), MAX_PROFILE_SECONDS) * 1000));
        const { profile } = await post<{ profile: CpuProfile }>('Profiler.stop');
        return summarizeCpuProfile(profile);
    } finally {
        session.disconnect();
        capturing = false;
    }
}
