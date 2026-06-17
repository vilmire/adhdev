/**
 * Faithful reproduction of the daemon's seed generator
 * (session-host-daemon/src/runtime.ts createXtermMirror + serializeXtermViewport).
 * Uses the IDENTICAL @xterm/xterm@6 + @xterm/addon-serialize@0.14 and the
 * IDENTICAL serialize options (range:{start,end}, excludeModes:true) +
 * trailing cursor-restore. Output == what the live daemon's formatVT() emits.
 *
 * Run under node:test (headless xterm — term.open() is never called).
 * Emits SEED cases as JSON for the wterm/xterm visual-fidelity comparison.
 */
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as XtermNS from '@xterm/xterm';
import * as SerializeNS from '@xterm/addon-serialize';
import fs from 'node:fs';

// CJS/ESM interop: resolve the constructors regardless of how the bundler
// exposes them (named, default, or default.X).
const Terminal: any = (XtermNS as any).Terminal || (XtermNS as any).default?.Terminal || (XtermNS as any).default;
const SerializeAddon: any = (SerializeNS as any).SerializeAddon || (SerializeNS as any).default?.SerializeAddon || (SerializeNS as any).default;

function formatCursorRestore(terminal: any, rows: number): string {
  const buffer = terminal.buffer.active;
  const row = Math.max(0, Math.min(Math.max(0, rows | 0) - 1, buffer.cursorY || 0));
  const col = Math.max(0, buffer.cursorX || 0);
  return `\x1b[${row + 1};${col + 1}H`;
}

function serializeXtermViewport(terminal: any, serializer: any, rows: number): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY || 0);
  const end = Math.max(start, Math.min(Math.max(0, buffer.length || 0) - 1, start + Math.max(1, rows | 0) - 1));
  if (end < start) return '';
  const viewport = serializer.serialize({ range: { start, end }, excludeModes: true });
  return `${viewport}${formatCursorRestore(terminal, rows)}`;
}

async function makeSeed(cols: number, rows: number, bytes: string): Promise<{ seed: string; cursor: { row: number; col: number } }> {
  const terminal = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  terminal.write(bytes);
  await delay(80);
  const seed = serializeXtermViewport(terminal, serializer, rows);
  const buffer = terminal.buffer.active;
  const cursor = { row: buffer.cursorY || 0, col: buffer.cursorX || 0 };
  serializer.dispose();
  terminal.dispose();
  return { seed, cursor };
}

test('generate daemon-equivalent seed cases', async () => {
  const cases: Record<string, { cols: number; rows: number; bytes: string; live?: string }> = {
    // 1. Ordinary SGR screen (colors, styles, CRLF rows).
    sgr_basic: {
      cols: 44, rows: 6,
      bytes:
        'prompt$ \x1b[1;32mrun\x1b[0m build\r\n' +
        '\x1b[33mwarning:\x1b[0m \x1b[3mdeprecated\x1b[0m flag\r\n' +
        '\x1b[34mINFO\x1b[0m \x1b[38;5;208m256orange\x1b[0m \x1b[48;5;24mbg\x1b[0m\r\n' +
        '\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m\r\n' +
        'done.',
    },
    // 2. Scrollback that MUST be stripped (the runtime.ts:213-218 stale-logo case,
    //    minus alt-screen). Old logo rows scroll off; only viewport should seed.
    scrollback_strip: {
      cols: 30, rows: 4,
      bytes:
        'OLD-LOGO-AAAA\r\nOLD-LOGO-BBBB\r\nOLD-LOGO-CCCC\r\n' +
        'OLD-LOGO-DDDD\r\nOLD-LOGO-EEEE\r\n' +
        '\x1b[31mCLAUDE\x1b[0m v1\r\nREADY >',
    },
    // 3. ALT-SCREEN full-screen TUI final state (the real /status -> Esc case).
    //    Enter alt-screen (1049h), draw a boxed full-screen UI, then the seed is
    //    taken WHILE STILL in alt-screen (daemon serializes the active viewport).
    altscreen_box: {
      cols: 40, rows: 8,
      bytes:
        // pre-altscreen noise that must NOT bleed into the seed
        'normal line 1\r\nnormal line 2\r\n' +
        '\x1b[?1049h' +            // enter alt screen
        '\x1b[2J\x1b[H' +          // clear + home
        '\x1b[1;36m┌──────────────────────────┐\x1b[0m\r\n' +
        '\x1b[1;36m│\x1b[0m \x1b[1mClaude Code — /status\x1b[0m     \x1b[1;36m│\x1b[0m\r\n' +
        '\x1b[1;36m├──────────────────────────┤\x1b[0m\r\n' +
        '\x1b[1;36m│\x1b[0m model: \x1b[32mclaude-opus\x1b[0m      \x1b[1;36m│\x1b[0m\r\n' +
        '\x1b[1;36m│\x1b[0m tokens: \x1b[33m12.4k\x1b[0m          \x1b[1;36m│\x1b[0m\r\n' +
        '\x1b[1;36m│\x1b[0m \x1b[2mPress Esc to close\x1b[0m       \x1b[1;36m│\x1b[0m\r\n' +
        '\x1b[1;36m└──────────────────────────┘\x1b[0m' +
        '\x1b[4;14H',           // cursor parked mid-box (live cursor)
    },
    // 4. Cursor-restore + live-incremental continuation. After seeding, a live
    //    chunk uses relative cursor movement and must land on the right row.
    cursor_continuity: {
      cols: 24, rows: 5,
      bytes: 'A\r\nB\r\nC\r\nstatus: \x1b[33mwaiting\x1b[0m\x1b[1A\rX',
      live: '\x1b[1B\rstatus: \x1b[32mdone\x1b[0m',
    },
  };

  const out: any = {};
  for (const [name, c] of Object.entries(cases)) {
    const { seed, cursor } = await makeSeed(c.cols, c.rows, c.bytes);
    out[name] = { cols: c.cols, rows: c.rows, seed, cursor, live: c.live ?? null };
  }
  // Write next to this file. Run from repo root with:
  //   npx tsx --test oss/packages/terminal-render-web/poc-playground/gen-daemon-seeds.test.ts
  const outPath = new URL('./seeds.json', import.meta.url).pathname;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  for (const [name, v] of Object.entries(out)) {
    // eslint-disable-next-line no-console
    console.log(`SEED[${name}] len=${(v as any).seed.length} cursor=${JSON.stringify((v as any).cursor)}`);
    console.log(`  JSON=${JSON.stringify((v as any).seed)}`);
  }
});
