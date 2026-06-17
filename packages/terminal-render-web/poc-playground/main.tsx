import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalView } from '../src/index';
import type { TerminalRendererHandle, TerminalRendererBackend } from '../src/index';

// A representative byte stream exercising: plain text, CRLF, SGR colors,
// cursor movement, bold, a box-drawing TUI fragment, and a 256-color span.
const DEMO_STREAM = [
  '\x1b[2J\x1b[H',
  'wterm-ghostty PoC — live render check\r\n',
  '\x1b[1;32m✔ bold green\x1b[0m  \x1b[33myellow\x1b[0m  \x1b[34mblue\x1b[0m  \x1b[31;1mred-bold\x1b[0m\r\n',
  '\x1b[38;5;208m256-color orange\x1b[0m \x1b[48;5;24m bg-cell \x1b[0m\r\n',
  '\r\n',
  '┌─────────────────────────────┐\r\n',
  '│  box drawing + unicode 🚀✨  │\r\n',
  '└─────────────────────────────┘\r\n',
  '\r\n',
  'prompt$ echo "feed via write()"\r\n',
  'feed via write()\r\n',
  'prompt$ \x1b[5mblinking?\x1b[0m done.\r\n',
].join('');

function App() {
  const handleRef = useRef<TerminalRendererHandle | null>(null);
  const initialBackend = (new URLSearchParams(location.search).get('backend') as TerminalRendererBackend) || 'wterm';
  const [backend, setBackend] = useState<TerminalRendererBackend>(initialBackend === 'xterm' ? 'xterm' : 'wterm');
  const [lastInput, setLastInput] = useState('');
  const [visibleText, setVisibleText] = useState('');

  useEffect(() => {
    // Feed the demo stream a beat after mount so the renderer is ready.
    const id = setTimeout(() => {
      handleRef.current?.write(DEMO_STREAM);
    }, 600);
    return () => clearTimeout(id);
  }, [backend]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, padding: 8, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
        <strong>backend:</strong>
        {(['wterm', 'xterm'] as const).map((b) => (
          <label key={b} style={{ cursor: 'pointer' }}>
            <input type="radio" checked={backend === b} onChange={() => setBackend(b)} /> {b}
          </label>
        ))}
        <button onClick={() => handleRef.current?.write('\r\nlive type: hello\r\n')}>write()</button>
        <button onClick={() => handleRef.current?.clear()}>clear()</button>
        <button onClick={() => setVisibleText(handleRef.current?.getVisibleText() || '(empty)')}>getVisibleText()</button>
        <span data-testid="last-input">onInput: {JSON.stringify(lastInput)}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, border: '1px solid #313244', borderRadius: 8, overflow: 'hidden' }}>
        {/* key=backend forces a fresh mount when switching renderer */}
        <TerminalView
          key={backend}
          ref={handleRef}
          backend={backend}
          onInput={(d) => setLastInput(d)}
          fontSize={14}
          sizingMode="fit"
        />
      </div>
      {visibleText && (
        <pre data-testid="visible-text" style={{ maxHeight: 120, overflow: 'auto', margin: 0, fontSize: 11, background: '#1e1e2e', padding: 8, borderRadius: 6 }}>
          {visibleText}
        </pre>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
