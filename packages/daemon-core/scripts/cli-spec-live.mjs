#!/usr/bin/env node
/**
 * Live driver for cli-spec round 2 verification.
 *
 * Spawns a real provider PTY using SpecAdapter (no daemon, no
 * cli-state-engine). Sends a one-shot prompt, prints every verdict
 * change to stdout, and exits when the screen says idle for >= 5s OR
 * total timeout. Use this to verify decision_required surfaces with
 * the correct choices, and to drive a numbered choice to resolution.
 *
 * Usage:
 *   node scripts/cli-spec-live.mjs claude "Create /tmp/spec-live.txt with hi"
 *   node scripts/cli-spec-live.mjs codex "Hello there"
 *
 * Auto-resolves choice 1 (Yes / Update now) when a decision appears.
 * Print --no-auto to skip that and just observe.
 */

import { spawn } from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const { evaluateScreen, resolveChoiceKey } = await import(
    url.pathToFileURL(path.join(__dirname, '../src/providers/cli-spec/evaluate.ts')).href
);
const { createScreenSink } = await import(
    url.pathToFileURL(path.join(__dirname, '../src/providers/cli-spec/screen.ts')).href
);

const providerArg = process.argv[2] || 'claude';
const message = process.argv[3] || `Create /tmp/spec-live-${Date.now()}.txt with the single word "hi".`;
const autoResolve = !process.argv.includes('--no-auto');

const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli', `${providerArg}-cli`, 'spec.json');
if (!fs.existsSync(specPath)) {
    console.error(`spec not found: ${specPath}`);
    process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
console.log(`[spec] loaded ${spec.id} binary=${spec.binary} args=${(spec.spawn_args||[]).join(' ')}`);

const pty = spawn(spec.binary, spec.spawn_args ?? [], {
    name: 'xterm-256color',
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: 100,
    rows: 30,
});
console.log(`[pty] spawned pid=${pty.pid}`);

const sink = createScreenSink({ cols: 100, rows: 30 });
let lastStatus = null;
let lastSignature = null;
let messageSentAt = 0;
let lastVerdictAt = Date.now();
let resolveCount = 0;

const startupGrace = setTimeout(() => {
    console.log(`[driver] startup grace elapsed — sending user message`);
    // Some TUIs swallow the first byte if it arrives in the same frame
    // as the input box mounts. Type one char at a time with tiny gaps.
    let i = 0;
    const interval = setInterval(() => {
        if (i >= message.length) {
            clearInterval(interval);
            setTimeout(() => {
                pty.write(spec.send.submit);
                messageSentAt = Date.now();
                console.log(`[driver] message sent (${message.length} chars)`);
            }, 200);
            return;
        }
        pty.write(message[i]);
        i += 1;
    }, 10);
}, 6000);

const DEBUG_RAW = process.argv.includes('--raw');
const DEBUG_SCREEN = process.argv.includes('--screen');
pty.onData((chunk) => {
    if (DEBUG_RAW) process.stderr.write(chunk);
    sink.write(chunk);
    const screen = sink.snapshot();
    if (DEBUG_SCREEN) process.stderr.write(`\n---SCREEN---\n${screen}\n---END---\n`);
    const v = evaluateScreen(screen, spec);
    const sig = v.status === 'decision_required' ? v.signature : null;
    if (v.status !== lastStatus || sig !== lastSignature) {
        lastStatus = v.status;
        lastSignature = sig;
        lastVerdictAt = Date.now();
        if (v.status === 'decision_required') {
            console.log(`[verdict] decision_required choices=${v.choices.length}`);
            for (const c of v.choices) console.log(`           ${c.index}. ${c.label}`);
            if (autoResolve && messageSentAt > 0 && resolveCount < 5) {
                resolveCount += 1;
                const key = resolveChoiceKey(spec, 1);
                console.log(`[driver] auto-resolving choice 1 (key=${JSON.stringify(key)}) — resolve#${resolveCount}`);
                setTimeout(() => pty.write(key), 250);
            }
        } else {
            console.log(`[verdict] ${v.status}`);
        }
    }
});

pty.onExit((info) => {
    clearTimeout(startupGrace);
    console.log(`[pty] exit code=${info.exitCode}`);
    process.exit(info.exitCode ?? 0);
});

const idleExitCheck = setInterval(() => {
    if (messageSentAt === 0) return;
    const sinceMessage = Date.now() - messageSentAt;
    const sinceVerdict = Date.now() - lastVerdictAt;
    if (sinceMessage > 12000 && sinceVerdict > 5000 && lastStatus === 'idle') {
        console.log(`[driver] idle for ${sinceVerdict}ms after message — exiting`);
        clearInterval(idleExitCheck);
        clearTimeout(startupGrace);
        pty.kill();
    }
}, 1000);

setTimeout(() => {
    console.log('[driver] absolute timeout (90s) — exiting');
    clearInterval(idleExitCheck);
    clearTimeout(startupGrace);
    pty.kill();
}, 90000);
