#!/usr/bin/env node
/**
 * Quick TUI snapshot tool. Spawns a binary in a headless xterm,
 * optionally sends a message, sleeps, dumps the final visible screen.
 * Used to author spec.json by inspection.
 *
 *   npx tsx scripts/capture-tui.mjs <binary> --args="chat" --wait=4
 *   npx tsx scripts/capture-tui.mjs hermes --args="chat" --send="hi" --wait=8
 */
import { spawn } from 'node-pty';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

const args = process.argv.slice(2);
const binary = args.shift();
if (!binary) { console.error('usage: capture-tui <binary> [--args="..."] [--send="..."] [--wait=<sec>]'); process.exit(2); }

const opt = Object.fromEntries(args.map(a => {
    const m = a.match(/^--([a-z]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const spawnArgs = opt.args ? opt.args.split(/\s+/) : [];
const waitMs = (Number(opt.wait) || 4) * 1000;
const cols = Number(opt.cols) || 100;
const rows = Number(opt.rows) || 30;

const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
const pty = spawn(binary, spawnArgs, {
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
    cols, rows,
});

pty.onData((chunk) => term.write(chunk));
pty.onExit(({ exitCode }) => { dump(`exit=${exitCode}`); process.exit(exitCode ?? 0); });

setTimeout(() => {
    dump('after-startup');
    if (opt.send) {
        for (const ch of String(opt.send)) pty.write(ch);
        pty.write('\r');
        setTimeout(() => { dump('after-send'); pty.kill(); }, waitMs);
    } else {
        pty.kill();
    }
}, waitMs);

function dump(label) {
    const buf = term.buffer.active;
    const out = [];
    for (let y = 0; y < buf.length; y += 1) {
        const line = buf.getLine(y);
        if (!line) continue;
        out.push(line.translateToString(true));
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    process.stdout.write(`\n=== ${label} (${out.length} lines) ===\n`);
    for (let i = 0; i < out.length; i += 1) process.stdout.write(`${String(i).padStart(2,'0')} | ${out[i]}\n`);
}
