/**
 * P1 production-quality harness: exercises fontSize change, measured-mode
 * container resize → grid reflow, scrollback scroll, and selection/copy on the
 * wterm backend (default) — comparable against xterm via ?backend=xterm.
 *
 * Buttons drive the same TerminalRendererHandle the dashboard uses.
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalView } from '../src/index';
import type { TerminalRendererHandle, TerminalRendererBackend } from '../src/index';

// Many lines so scrollback exists at small viewport heights.
const MANY_LINES = Array.from({ length: 60 }, (_, i) =>
  `line ${String(i + 1).padStart(2, '0')}: \x1b[3${(i % 7) + 1}mcolored token ${i}\x1b[0m the quick brown fox`,
).join('\r\n') + '\r\n';

function App() {
  const params = new URLSearchParams(location.search);
  const backend = (params.get('backend') === 'xterm' ? 'xterm' : 'wterm') as TerminalRendererBackend;
  const ref = useRef<TerminalRendererHandle | null>(null);
  const [w, setW] = useState(560);
  const [h, setH] = useState(300);
  const [fontSize, setFontSize] = useState(14);
  const [info, setInfo] = useState('');
  const [scroll, setScroll] = useState<any>(null);

  useEffect(() => {
    const t = setTimeout(() => { ref.current?.reset(); ref.current?.write(MANY_LINES); }, 700);
    return () => clearTimeout(t);
  }, [backend]);

  return (
    <div style={{ fontFamily: 'system-ui', color: '#cdd6f4', padding: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, marginBottom: 6 }}>
        <b data-testid="backend">backend={backend}</b>
        <button onClick={() => { setW((x) => (x === 560 ? 360 : 560)); }}>toggle width</button>
        <button onClick={() => { setH((x) => (x === 300 ? 180 : 300)); }}>toggle height</button>
        <button onClick={() => { setFontSize((x) => (x === 14 ? 20 : 14)); }}>toggle font ({fontSize})</button>
        <button onClick={() => { ref.current?.bumpResize(); }}>bumpResize</button>
        <button onClick={() => { ref.current?.scrollToTop(); }}>scrollToTop</button>
        <button onClick={() => { setInfo('sel=' + JSON.stringify(ref.current?.getSelection() || '') + ' vis=' + JSON.stringify((ref.current?.getVisibleText() || '').slice(0, 40))); }}>read selection/visible</button>
        <span data-testid="scroll">{scroll ? `scrollTop=${Math.round(scroll.scrollTop)} canScroll=${scroll.canScroll} atTop=${scroll.atTop}` : 'no scroll metrics'}</span>
      </div>
      <div data-testid="info" style={{ fontSize: 11, fontFamily: 'monospace', minHeight: 16, marginBottom: 6 }}>{info}</div>
      <div
        data-testid="frame"
        style={{ width: w, height: h, border: '1px solid #313244', resize: 'both', overflow: 'hidden' }}
      >
        <TerminalView
          key={backend}
          ref={ref}
          backend={backend}
          onInput={() => {}}
          fontSize={fontSize}
          sizingMode="measured"
          onScrollMetrics={(m) => setScroll(m)}
          onResize={(c, r) => setInfo((prev) => `resize→${c}x${r}`)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
