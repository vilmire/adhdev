/**
 * PERMISSION-MODE-DUPLICATE regression.
 *
 * A `launch-args` auto-approve mode prepends its `launchArgs` to the per-launch
 * args, while the provider's own base args still declare the same flag. Both
 * sources reach the PTY, so grok-cli launched in `auto` mode spawned
 *
 *     grok --permission-mode acceptEdits --permission-mode auto
 *
 * which grok's Rust/clap parser rejects outright. claude-cli hits the identical
 * collision but uses commander.js, which silently keeps the last occurrence —
 * same defect, no error, which is why it went unnoticed.
 *
 * These tests assert on the FINAL ARGV (`resolveCliSpawnPlanFromParts().allArgs`),
 * not on `provider.spawn.args`. The pre-existing coverage in
 * cli-provider-auto-approve-modes.test.ts asserted the latter and passed
 * throughout the defect's lifetime: `applyAutoApproveModeLaunchArgs` filtered the
 * MANIFEST correctly, but the spec path spawns from the SPEC's `spawn_args` and
 * never saw the removeArgs list at all.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    dedupeBaseArgsAgainstExtraArgs,
    resolveCliSpawnPlanFromParts,
    stripRemovedSpawnArgs,
} from '../../src/cli-adapters/provider-cli-runtime.js';
import type {
    PtyRuntimeTransport,
    PtySpawnOptions,
    PtyTransportFactory,
} from '../../src/cli-adapters/pty-transport.js';
import { applyAutoApproveModeLaunchArgs } from '../../src/commands/cli-manager.js';
import { createCliAdapter } from '../../src/providers/spec/route.js';
import type { CliProviderModule } from '../../src/cli-adapters/provider-cli-shared.js';
import type { ProviderModule } from '../../src/providers/contracts.js';

/** The real grok-cli auto-approve block (adhdev-providers/cli/grok-cli/provider.v1.json). */
const GROK_PROVIDER = {
    type: 'grok-cli',
    name: 'Grok CLI',
    category: 'cli',
    spawn: { command: 'grok', args: ['--permission-mode', 'acceptEdits'], shell: true },
    autoApproveModes: {
        default: 'pty-parse',
        modes: [
            { id: 'pty-parse', label: 'PTY parse', strategy: 'pty-parse-default', risk: 'safe' },
            {
                id: 'auto',
                label: 'Auto',
                strategy: 'launch-args',
                risk: 'caution',
                launchArgs: ['--permission-mode', 'auto'],
                removeArgs: ['--permission-mode', 'acceptEdits'],
            },
        ],
    },
} as unknown as ProviderModule;

/** grok-cli's specs/1.0.json base args — same flag as the manifest. */
const GROK_SPEC_SPAWN_ARGS = ['--permission-mode', 'acceptEdits'];

/**
 * claude-cli's manifest and spec disagree on the VALUE of the shared flag
 * (manifest `acceptEdits`, specs/4.0.json `default`) — the reason the fix threads
 * the removeArgs LIST rather than a pre-filtered manifest array.
 */
const CLAUDE_PROVIDER = {
    ...GROK_PROVIDER,
    type: 'claude-cli',
    name: 'Claude Code',
    spawn: { command: 'claude', args: ['--permission-mode', 'acceptEdits'], shell: true },
} as unknown as ProviderModule;
const CLAUDE_SPEC_SPAWN_ARGS = ['--permission-mode', 'default'];

function countOccurrences(args: string[], token: string): number {
    return args.filter((arg) => arg === token).length;
}

function argvFor(specSpawnArgs: string[], provider: ProviderModule): string[] {
    // Mirror the real launch: cli-manager resolves the mode, then the spec path
    // (route → SpecCliAdapter → FsmDriver.buildAdapterOpts) strips removeArgs from
    // the spec's spawn_args before handing them to the shared spawn planner.
    const launch = applyAutoApproveModeLaunchArgs(provider, [], { autoApproveMode: 'auto' });
    return resolveCliSpawnPlanFromParts({
        command: provider.spawn!.command,
        baseArgs: stripRemovedSpawnArgs(specSpawnArgs, launch.removeArgs ?? []),
        workingDir: '/tmp/permission-mode-dedupe',
        extraArgs: launch.cliArgs ?? [],
    }).allArgs;
}

describe('PERMISSION-MODE-DUPLICATE: final argv carries --permission-mode exactly once', () => {
    it('grok-cli (clap — hard error on a repeated flag)', () => {
        const argv = argvFor(GROK_SPEC_SPAWN_ARGS, GROK_PROVIDER);

        expect(countOccurrences(argv, '--permission-mode')).toBe(1);
        expect(argv).toEqual(['--permission-mode', 'auto']);
        // The replaced value must not survive as a stray positional.
        expect(argv).not.toContain('acceptEdits');
    });

    it('claude-cli (commander.js — silent last-wins), whose spec value differs from its manifest', () => {
        const argv = argvFor(CLAUDE_SPEC_SPAWN_ARGS, CLAUDE_PROVIDER);

        expect(countOccurrences(argv, '--permission-mode')).toBe(1);
        expect(argv).toEqual(['--permission-mode', 'auto']);
        // 'default' is the SPEC's value and is absent from removeArgs — it must still
        // be dropped, by position, or it lands as a positional argument.
        expect(argv).not.toContain('default');
    });

    it('threads the removeArgs LIST, so the spec keeps its own value when no mode is active', () => {
        const inactive = applyAutoApproveModeLaunchArgs(CLAUDE_PROVIDER, [], { autoApproveMode: 'pty-parse' });
        expect(inactive.removeArgs).toBeUndefined();

        const argv = resolveCliSpawnPlanFromParts({
            command: 'claude',
            baseArgs: stripRemovedSpawnArgs(CLAUDE_SPEC_SPAWN_ARGS, inactive.removeArgs ?? []),
            workingDir: '/tmp/permission-mode-dedupe',
            extraArgs: inactive.cliArgs ?? [],
        }).allArgs;

        // pty-parse is the default strategy: the spec's own base args stand unchanged.
        expect(argv).toEqual(['--permission-mode', 'default']);
    });
});

/**
 * End-to-end over the real wiring: createCliAdapter → SpecCliAdapter → FsmDriver →
 * resolveCliSpawnPlanFromParts → PTY. A recording transport factory captures the argv
 * that would have reached the CLI, so this covers the threading itself rather than
 * re-deriving it the way the unit tests above do.
 */
const tmpDirs: string[] = [];
afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSpec(id: string, spawnArgs: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `permission-mode-${id}-`));
    tmpDirs.push(dir);
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
        $schema: 'adhdev:cli/spec@4',
        id,
        name: id,
        binary: '/bin/true',
        spawn_args: spawnArgs,
        send_message: { submit_key: '\r' },
        sections: {},
        states: [{ id: 'idle', label: 'Idle', initial: true, status: 'idle' }],
        transitions: [],
    }));
    return specPath;
}

class RecordingTransportFactory implements PtyTransportFactory {
    spawnedArgs: string[] | null = null;

    spawn(_command: string, args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.spawnedArgs = args;
        return {
            pid: 1,
            ready: Promise.resolve(),
            write: () => {},
            resize: () => {},
            kill: () => {},
            onData: () => {},
            onExit: () => {},
        };
    }
}

async function spawnedArgvThroughRealWiring(
    specId: string,
    specSpawnArgs: string[],
    provider: ProviderModule,
): Promise<string[]> {
    const launch = applyAutoApproveModeLaunchArgs(provider, [], { autoApproveMode: 'auto' });
    const transport = new RecordingTransportFactory();
    const adapter = createCliAdapter(
        {
            ...(launch.provider as unknown as CliProviderModule),
            _resolvedSpecPath: writeSpec(specId, specSpawnArgs),
        } as unknown as CliProviderModule,
        os.tmpdir(),
        launch.cliArgs ?? [],
        {},
        transport,
        undefined,
        launch.removeArgs,
    );
    await adapter.spawn();
    await adapter.stop?.();
    if (!transport.spawnedArgs) throw new Error('transport never spawned');
    // /bin/true is not a Mach-O/ELF binary on every runner, so the planner may wrap
    // the launch in a login shell: ['-l', '-c', '/bin/true --permission-mode auto'].
    // Recover the argv from whichever shape came back. Every token here is a flag or
    // a bare value, so a whitespace split (with quote stripping) is exact.
    const spawned = transport.spawnedArgs;
    if (spawned[0] !== '-l') return spawned;
    return spawned[2]
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.replace(/^'(.*)'$/, '$1'))
        .slice(1);
}

describe('PERMISSION-MODE-DUPLICATE: real createCliAdapter → FsmDriver → PTY wiring', () => {
    it('spawns grok-cli with a single --permission-mode', async () => {
        const argv = await spawnedArgvThroughRealWiring('grok-cli', GROK_SPEC_SPAWN_ARGS, GROK_PROVIDER);

        expect(countOccurrences(argv, '--permission-mode')).toBe(1);
        expect(argv).toEqual(['--permission-mode', 'auto']);
    });

    it('spawns claude-cli with a single --permission-mode despite the spec/manifest value mismatch', async () => {
        const argv = await spawnedArgvThroughRealWiring('claude-cli', CLAUDE_SPEC_SPAWN_ARGS, CLAUDE_PROVIDER);

        expect(countOccurrences(argv, '--permission-mode')).toBe(1);
        expect(argv).toEqual(['--permission-mode', 'auto']);
        expect(argv).not.toContain('default');
    });
});

describe('resolveCliSpawnPlanFromParts last-wins dedupe (defence in depth)', () => {
    it('drops a base flag and its value when extraArgs declares the same flag', () => {
        // The chokepoint alone fixes the collision even with removeArgs unthreaded —
        // this is what covers claude-cli's latent case and any future provider.
        const { allArgs } = resolveCliSpawnPlanFromParts({
            command: 'grok',
            baseArgs: ['--permission-mode', 'acceptEdits'],
            workingDir: '/tmp/permission-mode-dedupe',
            extraArgs: ['--permission-mode', 'auto'],
        });
        expect(allArgs).toEqual(['--permission-mode', 'auto']);
    });

    it('leaves unrelated base args, positionals and order alone', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--model', 'sonnet', '--permission-mode', 'acceptEdits', '--verbose', 'chat'],
            ['--permission-mode', 'auto'],
        )).toEqual(['--model', 'sonnet', '--verbose', 'chat']);
    });

    it('matches the --flag=value spelling on either side without eating a neighbour', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--permission-mode=acceptEdits', '--verbose'],
            ['--permission-mode', 'auto'],
        )).toEqual(['--verbose']);
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--permission-mode', 'acceptEdits', '--verbose'],
            ['--permission-mode=auto'],
        )).toEqual(['--verbose']);
    });

    it('keeps a boolean base flag intact when its neighbour is another flag', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--yolo', '--permission-mode', 'acceptEdits'],
            ['--yolo'],
        )).toEqual(['--permission-mode', 'acceptEdits']);
    });

    it('is a no-op when extraArgs declares no flags', () => {
        expect(dedupeBaseArgsAgainstExtraArgs(
            ['--permission-mode', 'acceptEdits'],
            ['resume', 'session-1'],
        )).toEqual(['--permission-mode', 'acceptEdits']);
    });
});

describe('stripRemovedSpawnArgs', () => {
    it('removes a flag together with its value even when the value is not listed', () => {
        // claude-cli's spec says `default`; removeArgs only lists `acceptEdits`.
        expect(stripRemovedSpawnArgs(['--permission-mode', 'default', '--verbose'], ['--permission-mode']))
            .toEqual(['--verbose']);
    });

    it('still matches a bare value entry, preserving the manifest-path behaviour', () => {
        expect(stripRemovedSpawnArgs(['acceptEdits', '--base'], ['acceptEdits'])).toEqual(['--base']);
    });

    it('returns the base args unchanged for an empty removeArgs list', () => {
        expect(stripRemovedSpawnArgs(['--permission-mode', 'default'], []))
            .toEqual(['--permission-mode', 'default']);
    });
});
