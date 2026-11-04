import { describe, expect, it } from 'vitest';
import { captureDaemonCpuProfile, summarizeCpuProfile, type CpuProfile } from '../../src/process/daemon-cpu-profile.js';

const frame = (id: number, functionName: string, children: number[] = []) =>
    ({ id, children, callFrame: { functionName, url: 'file:///x/dist/index.js', lineNumber: id } });

describe('daemon cpu profile', () => {
    it('names the code in an unbroken stretch and splits stretches at idle', () => {
        const profile: CpuProfile = {
            nodes: [frame(1, '(root)', [2, 3, 5]), frame(2, 'outer', [4]), frame(3, '(idle)'), frame(4, 'readEverything'), frame(5, '(garbage collector)')],
            samples: [4, 4, 5, 3, 2, 3],
            timeDeltas: [800_000, 900_000, 100_000, 500_000, 200_000, 100_000],
            startTime: 0, endTime: 2_600_000,
        };
        const s = summarizeCpuProfile(profile);
        expect(s).toMatchObject({ busyMs: 1900, gcMs: 100, idleMs: 600 });
        expect(s.stalls).toHaveLength(1);
        expect(s.stalls[0]).toMatchObject({ ms: 1800 });
        expect(s.stalls[0]!.stacks[0]!.stack[0]).toContain('readEverything');
        expect(s.topSelf[0]!.frame).toContain('readEverything');
        expect(s.topInclusive.map(f => f.frame).join()).toContain('outer');
    });
    it('samples this process and leaves the sampler free for the next capture', async () => {
        const holdTheLoop = () => { const until = Date.now() + 1300; while (Date.now() < until) { /* spin */ } };
        const capture = captureDaemonCpuProfile(2);
        await expect(captureDaemonCpuProfile(1)).rejects.toThrow('cpu_profile_in_progress');
        setTimeout(holdTheLoop, 300);
        const s = await capture;
        expect(s.stalls.length).toBeGreaterThan(0);
        expect(s.topSelf.map(f => f.frame).join()).toContain('holdTheLoop');
        await expect(captureDaemonCpuProfile(1)).resolves.toMatchObject({ sampledMs: expect.any(Number) });
    }, 15_000);
});
