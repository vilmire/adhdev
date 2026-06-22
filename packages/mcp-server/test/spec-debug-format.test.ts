import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSpecDebugResult } from '../src/tools/spec-debug.js';

// A long body section whose tail marker sits well past the old 120-char preview
// cap — used to prove sections are now rendered in full (no truncation).
const LONG_BODY =
  'line 1 of the body\n' +
  'x'.repeat(140) + 'END_OF_BODY_MARKER\n' +
  '✻ Worked for 8s';

function makeResult() {
  const now = Date.now();
  return {
    success: true,
    providerType: 'claude-cli',
    snapshot: {
      cliType: 'claude-cli',
      spec_id: 'claude-cli',
      specPath: '/x/4.0.json',
      current_state: { id: 'busy', label: 'Generating' },
      idleHoldPending: false,
      lastBusyAt: now,
      exited: false,
      sections: {
        body: LONG_BODY,
        footer: '❯ ',
        modal: '',
      },
      stateHistory: [
        {
          stateId: 'busy', label: 'Generating', at: now - 500, durationMs: 1200,
          via: 'idle→busy',
          matchedRules: [
            'idle→busy fired',
            '  regex body~/spinner/ = true matched="✻ Working… (esc to interrupt)"',
          ],
        },
      ],
      eventTimeline: [
        { ts: now - 900, kind: 'input', content: 'hello world\\r', bytes: 12 },
        { ts: now - 700, kind: 'output', content: '⏺ Working on it', bytes: 220 },
        { ts: now - 500, kind: 'cursor', content: '(5,2)' },
        { ts: now - 100, kind: 'resize', content: '120x40' },
      ],
    },
  };
}

test('spec debug snapshot renders the Event Timeline section with input/output', () => {
  const out = formatSpecDebugResult(makeResult(), { sessionId: 's1' });
  assert.match(out, /## Event Timeline/);
  assert.match(out, /hello world\\r/);          // injected input preview is shown
  assert.match(out, /⏺ Working on it/);         // PTY output preview is shown
  assert.match(out, /120x40/);                  // resize event
  assert.match(out, /\(5,2\)/);                 // cursor event
  assert.match(out, /\[220b\]/);                // raw byte length surfaced
});

test('spec debug snapshot renders FULL section text (no 120-char truncation)', () => {
  const out = formatSpecDebugResult(makeResult(), { sessionId: 's1' });
  assert.match(out, /## Sections/);
  // The tail marker lives past char 150 of the body; old code sliced at 120.
  assert.match(out, /END_OF_BODY_MARKER/);
  // Newlines must be preserved (not collapsed to ↵).
  assert.ok(!out.includes('↵'), 'section text should not collapse newlines to ↵');
});

test('spec debug snapshot renders state-history rules (via + matchedRules + matched text)', () => {
  const out = formatSpecDebugResult(makeResult(), { sessionId: 's1' });
  assert.match(out, /## State History/);
  assert.match(out, /via idle→busy/);
  assert.match(out, /idle→busy fired/);
  assert.match(out, /matched="✻ Working… \(esc to interrupt\)"/);
});

test('json format passes through untouched', () => {
  const out = formatSpecDebugResult(makeResult(), { sessionId: 's1', format: 'json' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.success, true);
  assert.equal(parsed.snapshot.cliType, 'claude-cli');
});
