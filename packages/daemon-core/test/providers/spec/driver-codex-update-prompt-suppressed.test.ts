/**
 * CODEX-UPDATE-PROMPT-EXIT — a daemon-driven codex session exits with code 1 a
 * second after its first task is delivered, before any turn starts.
 *
 * Reproduced offline (codex 0.156.1, 2026-09-29, npm registry latest 0.158.0):
 * when `$CODEX_HOME/version.json` caches a newer release, codex opens its
 * startup update prompt, whose DEFAULT selection is option 1:
 *
 *   › 1. Update now (runs `npm install -g @openai/codex`)
 *     2. Skip
 *     3. Skip until next version
 *   enter continue · esc skip
 *
 * The codex spec has no modal landmark for this screen, so the FSM leaves
 * `starting` through `startup-grace` into `idle` and the daemon types the task
 * body followed by `\r`. That Enter confirms "Update now": codex prints
 * "Updating Codex via `npm install -g @openai/codex`...", runs a GLOBAL npm
 * install underneath every other codex process on the host, and exits — with
 * status 1 when the install fails (concurrent installs, a locked binary on
 * win32, no write access to the global prefix). Captured with a stub `npm`:
 *
 *   Error: `npm install -g @openai/codex` failed with status exit status: 1
 *   → process exit status 1, 1.1 s after the task write
 *
 * Which launches see the prompt: any whose CODEX_HOME already holds a
 * `version.json` naming a newer release — the owner's real `~/.codex`
 * (non-isolated launches, the codex coordinator, a win32 worker that fell back
 * to the real home before the junction fix) — never a brand-new private root
 * on its first run (verified: 3/3 fresh roots showed no prompt).
 *
 * The fix is launch-time and declarative: the spec passes
 * `-c check_for_update_on_startup=false`, codex's own switch for this prompt
 * (verified: with the same cached version.json the prompt no longer renders
 * and the composer is reachable). A daemon-driven session must never
 * self-update — the daemon types into it blind during startup grace, and a
 * global reinstall is an operator decision, not a side effect of a task.
 *
 * Asserted on the argv the real FsmDriver hands to the PTY (spec spawn_args →
 * resolveCliSpawnPlanFromParts → transport), not on the JSON alone, so a spawn
 * refactor that drops the spec's base args fails here too.
 *
 * ★That assertion is what exposed the second half of the defect: the base-vs-
 * extra arg dedupe keyed every option by its bare flag, so ANY per-launch
 * `-c …` (a delegated launch always carries several) erased EVERY `-c` the spec
 * declared. The spec edit alone therefore never reached a worker. The dedupe now
 * keys `-c key=value` by `-c key`: different keys coexist, the same key is still
 * last-wins.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { dedupeBaseArgsAgainstExtraArgs } from '../../../src/cli-adapters/provider-cli-runtime.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS = path.resolve(HERE, '../../../../../../adhdev-providers');
const SPEC_PATH = path.join(PROVIDERS, 'cli/codex-cli/specs/4.0.json');

const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip;

class CapturingPty implements PtyRuntimeTransport {
    readonly pid = 4712;
    readonly ready = Promise.resolve();
    write(): void { /* no-op */ }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    onData(): void { /* no-op */ }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
}

class CapturingFactory implements PtyTransportFactory {
    command = '';
    args: string[] = [];
    spawn(command: string, args: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.command = command;
        this.args = [...args];
        return new CapturingPty();
    }
}

/** True when `-c <value>` appears as an adjacent pair, whether the plan passed
 *  argv through directly or folded it into a single shell command string. */
function hasConfigOverride(command: string, args: string[], value: string): boolean {
    for (let i = 0; i + 1 < args.length; i++) {
        if (args[i] === '-c' && args[i + 1] === value) return true;
    }
    const joined = [command, ...args].join(' ');
    return new RegExp(`(^|\\s)-c\\s+['"]?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?(\\s|$)`).test(joined);
}

maybe('codex-cli startup update prompt — suppressed at launch', () => {
    it('the shipping spec validates and declares the override in spawn_args', () => {
        const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
        expect(validateFsmSpec(raw)).toEqual([]);
        const spawnArgs: string[] = raw.spawn_args ?? [];
        const idx = spawnArgs.indexOf('check_for_update_on_startup=false');
        expect(idx).toBeGreaterThan(0);
        expect(spawnArgs[idx - 1]).toBe('-c');
    });

    it('the argv the driver spawns carries -c check_for_update_on_startup=false', () => {
        const factory = new CapturingFactory();
        const driver = new FsmDriver({
            specPath: SPEC_PATH,
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
        });
        driver.start();
        try {
            expect(factory.command).not.toBe('');
            expect(hasConfigOverride(factory.command, factory.args, 'check_for_update_on_startup=false')).toBe(true);
        } finally {
            driver.shutdown();
        }
    });

    it('the override survives the delegated-worker extra args (model / effort / worker MCP)', () => {
        const factory = new CapturingFactory();
        const driver = new FsmDriver({
            specPath: SPEC_PATH,
            workingDir: os.tmpdir(),
            hotReload: false,
            transportFactory: factory,
            extraCliArgs: [
                '-c', 'model_reasoning_effort=high',
                '-c', 'model=gpt-5.6-sol',
                '--dangerously-bypass-approvals-and-sandbox',
                '-c', 'mcp_servers.adhdev-worker.enabled=true',
            ],
        });
        driver.start();
        try {
            expect(hasConfigOverride(factory.command, factory.args, 'check_for_update_on_startup=false')).toBe(true);
            expect(hasConfigOverride(factory.command, factory.args, 'model=gpt-5.6-sol')).toBe(true);
        } finally {
            driver.shutdown();
        }
    });
});

describe('base-vs-extra arg dedupe — keyed repeatable options', () => {
    it('keeps a base -c override whose KEY the per-launch args do not repeat', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['-c', 'check_for_update_on_startup=false'],
            ['-c', 'model=gpt-5.6-sol', '-c', 'mcp_servers.adhdev-worker.enabled=true'],
        )).toEqual(['-c', 'check_for_update_on_startup=false']);
    });

    it('still drops a base -c override of the SAME key (last wins)', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['-c', 'model=base', '-c', 'check_for_update_on_startup=false'],
            ['-c', 'model=launch'],
        )).toEqual(['-c', 'check_for_update_on_startup=false']);
    });

    it('keys quoted TOML path segments too', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['-c', 'projects."/a".trust_level=trusted', '-c', 'projects."/b".trust_level=trusted'],
            ['-c', 'projects."/a".trust_level=untrusted'],
        )).toEqual(['-c', 'projects."/b".trust_level=trusted']);
    });

    it('leaves the plain --flag value collision behaviour unchanged', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--permission-mode', 'acceptEdits', '--verbose'],
            ['--permission-mode', 'auto'],
        )).toEqual(['--verbose']);
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--model=a', '--x'],
            ['--model', 'b'],
        )).toEqual(['--x']);
    });

    it('does not treat free text containing = as a keyed value', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--append-system-prompt', 'use a = b style'],
            ['--append-system-prompt', 'other a = c'],
        )).toEqual([]);
    });
});
