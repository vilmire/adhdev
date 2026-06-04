#!/usr/bin/env node
/**
 * Live driver for the spec round-3 SpecDriver. Spawns a provider via
 * the new pipeline (TerminalAdapter + SpecDriver), sends a user prompt,
 * prints every dashboard event, and auto-resolves first modal button
 * unless --no-auto.
 *
 * Usage:
 *   npx tsx scripts/spec-live.mjs claude-cli "Create /tmp/spec-live.txt with hi"
 *   npx tsx scripts/spec-live.mjs codex-cli "hello"  --no-auto
 *   add --trace to print spec_trace entries on every state change
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const { SpecDriver } = await import(
    url.pathToFileURL(path.join(__dirname, '../src/providers/spec/driver.ts')).href
);

const id = process.argv[2] || 'claude-cli';
const message = process.argv[3] || 'Hello from the live spec driver.';
const autoResolve = !process.argv.includes('--no-auto');
const wantTrace = process.argv.includes('--trace');

const specPath = path.join(REPO_ROOT, 'adhdev-providers/cli', id, 'spec.json');
if (!fs.existsSync(specPath)) {
    console.error(`spec not found: ${specPath}`);
    process.exit(2);
}
console.log(`[live] spec=${specPath}`);

const driver = new SpecDriver({
    specPath,
    workingDir: process.cwd(),
    cols: 100,
    rows: 30,
    hotReload: true,
    emitTrace: wantTrace,
});

let messageSentAt = 0;
let lastClickAt = 0;
let exitCode = null;

driver.subscribe((ev) => {
    if (ev.kind === 'pty_data') return;
    if (ev.kind === 'state_changed') {
        const m = ev.modal;
        console.log(`[state] ${ev.state.id} (${ev.state.label})${ev.state.title ? ` title="${ev.state.title}"` : ''}`);
        if (m) {
            console.log(`         modal: ${m.title ?? '(no title)'}`);
            for (const b of m.buttons) console.log(`            ${b.index}. ${b.label}`);
            if (autoResolve && messageSentAt > 0 && Date.now() - lastClickAt > 500) {
                lastClickAt = Date.now();
                setTimeout(() => {
                    console.log(`[live] auto-clicking modal button 1`);
                    driver.dispatch({ kind: 'click_modal_button', index: 1 });
                }, 250);
            }
        }
        if (ev.controls.length > 0) {
            console.log(`         controls: ${ev.controls.map(c => `${c.label}[${c.action_type}]`).join(', ')}`);
        }
    } else if (ev.kind === 'notification') {
        console.log(`[notif] ${ev.title}${ev.body ? ` — ${ev.body}` : ''}`);
    } else if (ev.kind === 'delegate') {
        console.log(`[deleg] ${ev.id}: ${ev.task}`);
    } else if (ev.kind === 'spec_trace') {
        for (const e of ev.entries) console.log(`        trace[${e.kind}] ${e.text}`);
    } else if (ev.kind === 'spec_error') {
        console.log(`[error] spec reload failed: ${ev.errors.join('; ')}`);
    } else if (ev.kind === 'exit') {
        console.log(`[live] exit ${ev.exit_code}`);
        exitCode = ev.exit_code;
        process.exit(exitCode ?? 0);
    }
});

driver.start();

setTimeout(() => {
    console.log(`[live] sending: ${JSON.stringify(message)}`);
    driver.dispatch({ kind: 'send_message', text: message });
    messageSentAt = Date.now();
}, 6000);

setTimeout(() => {
    console.log('[live] absolute timeout (120s) — shutting down');
    driver.dispatch({ kind: 'shutdown' });
}, 120000);
