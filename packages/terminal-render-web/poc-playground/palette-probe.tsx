// Probe libghostty's baked ANSI 16-color palette by writing one glyph per
// ANSI color and reading the core's resolved fgRgb. Output to the DOM so a CDP
// driver can read it. Used to build the ghostty→catppuccin remap table.
import { GhosttyCore } from '@wterm/ghostty';

(async () => {
  const el = document.getElementById('out')!;
  try {
    const core: any = await GhosttyCore.load();
    core.init(40, 20);
    let s = '';
    for (let i = 0; i < 16; i++) {
      const code = i < 8 ? 30 + i : 90 + (i - 8);
      s += `\x1b[${code}mX\x1b[0m\r\n`;
    }
    core.writeString(s);
    const out: string[] = [];
    for (let i = 0; i < 16; i++) {
      const cell = core.getCell(i, 0);
      const rgb = cell?.fgRgb;
      out.push(`${i}:${rgb != null ? '#' + (rgb >>> 0).toString(16).padStart(6, '0') : 'idx'}`);
    }
    el.textContent = 'PALETTE ' + out.join(' ');
  } catch (e: any) {
    el.textContent = 'ERR ' + (e?.message || e);
  }
})();
