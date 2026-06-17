/**
 * Verifies the production opt-in loop end to end:
 *   TerminalRendererSection toggle → localStorage 'adhdev:terminalRenderer'
 *   → selectTerminalRendererBackend() (no explicit backend prop)
 *   → TerminalView renders xterm or wterm.
 *
 * The terminal below is keyed on a "generation" counter that the page bumps on
 * reload-equivalent, so we can observe the selected backend after toggling.
 */
import { useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalView, selectTerminalRendererBackend } from '../src/index';
import { TerminalRendererSection, getTerminalRendererBackend } from '@adhdev/web-core';
import type { TerminalRendererHandle } from '../src/index';

function App() {
  const ref = useRef<TerminalRendererHandle | null>(null);
  const resolved = selectTerminalRendererBackend(); // reads localStorage now
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.reset();
      ref.current?.write('settings-toggle loop check\r\n\x1b[32mselected backend resolved from localStorage\x1b[0m\r\n');
    }, 600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ color: '#cdd6f4', fontFamily: 'system-ui', padding: 12 }}>
      <div style={{ maxWidth: 520, marginBottom: 12, padding: 12, border: '1px solid #313244', borderRadius: 8 }}>
        <TerminalRendererSection />
      </div>
      <div data-testid="resolved" style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 8 }}>
        localStorage=<b data-testid="ls">{getTerminalRendererBackend()}</b> resolved=<b data-testid="resolvedVal">{resolved}</b>
      </div>
      <div style={{ width: 520, height: 160, border: '1px solid #313244' }}>
        {/* NO explicit backend prop — exercises selectTerminalRendererBackend() */}
        <TerminalView ref={ref} onInput={() => {}} fontSize={14} sizingMode="measured" />
      </div>
      <p style={{ fontSize: 11, color: '#9399b2' }}>Toggle above, then reload the page; the terminal re-mounts with the selected backend.</p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
