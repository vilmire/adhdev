/**
 * Model discovery execution — run one provider's declared source and turn its
 * output into a snapshot.
 *
 * Side effects are injected exactly as `quota/fetchers/deps.ts` injects them,
 * and for the same reason: a test must never spawn a real CLI nor read a real
 * config, and process-wide mocking of `node:child_process` is racy across
 * parallel test files.
 *
 * ★FAILURE IS A FIRST-CLASS RESULT, NEVER AN EMPTY LIST. Every failure path
 * returns a non-ok snapshot with a `failureKind`, and `overlay.ts` turns any
 * non-ok snapshot into "use the manifest". This is the contract that keeps a
 * signed-out `grok models` or an offline `agy models` from silently emptying
 * the user's picker — the one outcome that would be worse than being stale.
 */
'use strict';

import { spawn } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { LOG } from '../logging/logger.js';
import { parseModels } from './parse.js';
import type {
    DiscoveredModel,
    ModelDiscoveryFailureKind,
    ModelDiscoverySnapshot,
    ModelDiscoverySpec,
} from './types.js';

/**
 * Default spawn timeout. These are not all cheap local reads: `agy models`
 * prints "Fetching available models..." and goes to the network, so the budget
 * has to cover a round trip — while still being short enough that a hung CLI
 * cannot wedge a refresh.
 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

/**
 * Cap on captured stdout.
 *
 * ★Sized for codex: `codex debug models` emits ~350KB because each record
 * carries a `model_messages.persistent_instructions` block of prose. A tighter
 * cap would truncate the JSON mid-document and turn a healthy provider into a
 * permanent `parse` failure — so this is deliberately generous, and the parse
 * is not line-oriented.
 */
export const MODEL_DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Injectable side-effect surface, mirroring QuotaFetchDeps. */
export interface ModelDiscoveryDeps {
    spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
        stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
        on(event: 'error', listener: (err: Error) => void): void;
        on(event: 'exit', listener: (code: number | null) => void): void;
        kill(signal?: NodeJS.Signals): void;
    };
    readFile?: (filePath: string) => Promise<string>;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
}

function resolveDeps(overrides: ModelDiscoveryDeps = {}): Required<ModelDiscoveryDeps> {
    return {
        spawn: overrides.spawn ?? ((command, args, options) =>
            spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) as any),
        readFile: overrides.readFile ?? ((filePath) => fsReadFile(filePath, 'utf-8')),
        now: overrides.now ?? (() => Date.now()),
        env: overrides.env ?? process.env,
    };
}

/** Expand a leading `~` against the home directory. Read-only paths only. */
export function expandHome(filePath: string, homeDir: string = os.homedir()): string {
    if (filePath === '~') return homeDir;
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
        return path.join(homeDir, filePath.slice(2));
    }
    return filePath;
}

/**
 * Classify a failed command from its exit code and captured output.
 *
 * ★This is the investigation's explicitly UNVERIFIED case — what `grok models`
 * / `agy models` do when signed out or offline was never observed. So the
 * classification is heuristic ON PURPOSE and the heuristic only ever changes
 * the LABEL the user sees. Every branch here is already a non-ok status, and
 * every non-ok status falls back to the manifest identically. Guessing
 * `unknown` where the truth was `unauthenticated` costs a less specific
 * message, never a wrong model list.
 */
export function classifyFailure(output: string, exitCode: number | null): ModelDiscoveryFailureKind {
    const text = output.toLowerCase();
    if (/\b(not logged in|log ?in|sign ?in|unauthenticated|unauthorized|authentication|auth token|expired)\b/.test(text)) {
        return 'unauthenticated';
    }
    if (/\b(enotfound|econnrefused|etimedout|network|offline|dns|socket hang up|fetch failed)\b/.test(text)) {
        return 'network';
    }
    if (exitCode === 127 || /\b(command not found|no such file or directory)\b/.test(text)) {
        return 'cli-unavailable';
    }
    return 'unknown';
}

function failure(
    provider: string,
    failureKind: ModelDiscoveryFailureKind,
    error: string,
    now: number,
): ModelDiscoverySnapshot {
    return {
        provider,
        status: failureKind === 'cli-unavailable' ? 'unavailable' : 'error',
        models: [],
        updatedAt: now,
        fetchedAt: now,
        failureKind,
        error,
    };
}

/** Run a `command` source: spawn the provider's own listing subcommand and parse stdout. */
async function discoverByCommand(
    provider: string,
    binary: string,
    spec: Extract<ModelDiscoverySpec, { kind: 'command' }>,
    deps: Required<ModelDiscoveryDeps>,
): Promise<ModelDiscoverySnapshot> {
    const timeoutMs = spec.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
    const started = deps.now();

    const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: Error }>((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const finish = (value: { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: Error }) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(value);
        };

        let child: ReturnType<Required<ModelDiscoveryDeps>['spawn']>;
        try {
            child = deps.spawn(binary, spec.argv, { env: deps.env });
        } catch (e: any) {
            finish({ stdout: '', stderr: String(e?.message || e), code: null, timedOut: false, spawnError: e });
            return;
        }

        timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
            finish({ stdout, stderr, code: null, timedOut: true });
        }, timeoutMs);
        // Never hold the event loop open for a discovery probe.
        (timer as any).unref?.();

        child.stdout.on('data', (chunk) => {
            if (stdout.length < MODEL_DISCOVERY_MAX_OUTPUT_BYTES) stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 64 * 1024) stderr += chunk.toString();
        });
        child.on('error', (err) => finish({ stdout, stderr, code: null, timedOut: false, spawnError: err }));
        child.on('exit', (code) => finish({ stdout, stderr, code, timedOut: false }));
    });

    const now = deps.now();

    if (result.timedOut) {
        return failure(provider, 'timeout', `\`${binary} ${spec.argv.join(' ')}\` timed out after ${timeoutMs}ms`, now);
    }
    if (result.spawnError) {
        const kind = /ENOENT/i.test(String(result.spawnError.message)) ? 'cli-unavailable' : 'unknown';
        return failure(provider, kind, result.spawnError.message, now);
    }
    if (result.code !== 0) {
        const combined = `${result.stderr}\n${result.stdout}`;
        return failure(
            provider,
            classifyFailure(combined, result.code),
            result.stderr.trim() || `exited with code ${result.code}`,
            now,
        );
    }

    const models = parseModels(result.stdout, spec.parse);
    if (models.length === 0) {
        // ★Exit 0 with nothing parseable is NOT a success. Several of these CLIs
        // print a signed-out notice and still exit 0, so trusting the exit code
        // alone would cache an empty list as authoritative — exactly the
        // "silently empty picker" this design forbids. Classify from the output.
        const kind = classifyFailure(`${result.stdout}\n${result.stderr}`, result.code);
        return failure(provider, kind === 'unknown' ? 'parse' : kind, 'no models parsed from output', now);
    }

    LOG.debug?.('Models', `[${provider}] discovered ${models.length} models in ${now - started}ms`);
    return { provider, status: 'ok', models, updatedAt: now, fetchedAt: now };
}

/** Run a `file` source: read a config the CLI itself maintains (kimi). */
async function discoverByFile(
    provider: string,
    spec: Extract<ModelDiscoverySpec, { kind: 'file' }>,
    deps: Required<ModelDiscoveryDeps>,
): Promise<ModelDiscoverySnapshot> {
    const filePath = expandHome(spec.path);
    let raw: string;
    try {
        raw = await deps.readFile(filePath);
    } catch (e: any) {
        const now = deps.now();
        // An absent config is the ordinary "not signed in / never ran it" state,
        // not a defect — but it is still a failure for our purposes, so the
        // manifest list stands.
        const kind: ModelDiscoveryFailureKind = /ENOENT/i.test(String(e?.code || e?.message)) ? 'unauthenticated' : 'unknown';
        return failure(provider, kind, `cannot read ${filePath}: ${e?.message || e}`, now);
    }
    const now = deps.now();
    const models = parseModels(raw, spec.parse);
    if (models.length === 0) return failure(provider, 'parse', `no models parsed from ${filePath}`, now);
    return { provider, status: 'ok', models, updatedAt: now, fetchedAt: now };
}

/**
 * Discover one provider's models.
 *
 * `binary` is the CLI path resolved by provider DETECTION — discovery never
 * chooses an executable, so this can only ever run the CLI the user already
 * installed. `kind: 'none'` short-circuits without spawning anything.
 */
export async function discoverProviderModels(
    provider: string,
    spec: ModelDiscoverySpec | undefined,
    binary: string | undefined,
    overrides: ModelDiscoveryDeps = {},
): Promise<ModelDiscoverySnapshot> {
    const deps = resolveDeps(overrides);
    const now = deps.now();

    if (!spec) {
        return { provider, status: 'not-supported', models: [], updatedAt: now, fetchedAt: now, reason: 'provider declares no modelDiscovery block' };
    }
    if (spec.kind === 'none') {
        // ★Declared-undiscoverable is NOT a failure: it is a fact the badge
        // renders as "cannot verify". Distinguishing it from silence is the
        // whole reason `kind: 'none'` is written down rather than omitted.
        return { provider, status: 'not-supported', models: [], updatedAt: now, fetchedAt: now, reason: spec.reason };
    }
    if (spec.kind === 'file') {
        return discoverByFile(provider, spec, deps);
    }
    if (!binary) {
        return failure(provider, 'cli-unavailable', 'provider binary not detected on this machine', now);
    }
    try {
        return await discoverByCommand(provider, binary, spec, deps);
    } catch (e: any) {
        // Belt-and-braces: discovery must never reject, or one bad provider
        // takes down the whole refresh pass.
        return failure(provider, 'unknown', String(e?.message || e), deps.now());
    }
}

/** Convenience for tests and callers that only need the list. */
export function snapshotModels(snapshot: ModelDiscoverySnapshot | undefined): DiscoveredModel[] {
    return snapshot?.status === 'ok' ? snapshot.models : [];
}
