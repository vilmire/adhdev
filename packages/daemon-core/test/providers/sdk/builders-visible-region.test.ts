/**
 * Tests for applyVisibleRegion and its integration with detect-status /
 * parse-approval builders.
 *
 * The visible-region primitive scopes terminal text before matchers run,
 * which is critical for providers like Antigravity that redraw a full
 * separator + prompt on every turn — without scoping, old spinner / idle
 * cues from scrollback pollute the matcher result.
 */

import { describe, expect, it } from 'vitest';
import { applyVisibleRegion, type VisibleRegionSpec } from '../../../src/providers/sdk/v1/builders/cli/visible-region.js';
import {
  buildDetectStatusFromTui,
  type DetectStatusTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/detect-status.js';
import {
  buildParseApprovalFromTui,
  type ModalTuiSpec,
} from '../../../src/providers/sdk/v1/builders/cli/parse-approval.js';
import type {
  CliScreenSnapshot,
  CliStatusInput,
  CliApprovalInput,
} from '../../../src/providers/sdk/v1/types/cli/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function emptyScreen(text: string): CliScreenSnapshot {
  return {
    text,
    lineCount: text.split('\n').length,
    lines: [],
    nonEmptyLines: [],
    firstNonEmptyLineIndex: -1,
    lastNonEmptyLineIndex: -1,
    firstNonEmptyLine: null,
    lastNonEmptyLine: null,
    promptLineIndex: -1,
    promptLine: null,
    linesAbovePrompt: [],
    linesBelowPrompt: [],
  };
}

function statusInput(screenText: string): CliStatusInput {
  return {
    tail: screenText.split('\n').slice(-12).join('\n'),
    screenText,
    rawBuffer: screenText,
    isWaitingForResponse: false,
    screen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText.split('\n').slice(-12).join('\n')),
  };
}

function approvalInput(screenText: string): CliApprovalInput {
  return {
    buffer: screenText,
    screenText,
    rawBuffer: screenText,
    tail: screenText.split('\n').slice(-24).join('\n'),
    screen: emptyScreen(screenText),
    bufferScreen: emptyScreen(screenText),
    tailScreen: emptyScreen(screenText.split('\n').slice(-24).join('\n')),
  };
}

// ─── Unit tests: applyVisibleRegion ──────────────────────────────────────

describe('applyVisibleRegion — scope: buffer', () => {
  it('returns full text unchanged', () => {
    const spec: VisibleRegionSpec = { scope: 'buffer' };
    const text = 'line 1\nline 2\nline 3';
    expect(applyVisibleRegion(spec, text)).toBe(text);
  });
});

describe('applyVisibleRegion — scope: screen', () => {
  it('returns full text unchanged', () => {
    const spec: VisibleRegionSpec = { scope: 'screen' };
    const text = 'screen content here';
    expect(applyVisibleRegion(spec, text)).toBe(text);
  });
});

describe('applyVisibleRegion — scope: tail', () => {
  it('truncates to last tailChars characters', () => {
    const spec: VisibleRegionSpec = { scope: 'tail', tailChars: 10 };
    const text = 'abcdefghij_TAIL_END';
    // Length is 19; last 10 chars = '_TAIL_END\0'? Let me count:
    // 'abcdefghij_TAIL_END' — 19 chars, last 10 = '_TAIL_END' but that's 9.
    // Actually 'abcdefghij_TAIL_END':
    //  a b c d e f g h i j _ T A I L _ E N D  = 19 chars
    // last 10 = j_TAIL_END
    expect(applyVisibleRegion(spec, text)).toBe(text.slice(-10));
  });

  it('returns full text when length <= tailChars', () => {
    const spec: VisibleRegionSpec = { scope: 'tail', tailChars: 1000 };
    const text = 'short text';
    expect(applyVisibleRegion(spec, text)).toBe(text);
  });

  it('defaults to 4000 chars when tailChars is not set', () => {
    const spec: VisibleRegionSpec = { scope: 'tail' };
    const text = 'x'.repeat(5000);
    expect(applyVisibleRegion(spec, text)).toHaveLength(4000);
  });
});

describe('applyVisibleRegion — scope: between-anchors, selectAnchor: "last"', () => {
  it('returns text between the LAST top anchor end and the first bottom after it', () => {
    // Top anchor = separator line + prompt marker; bottom anchor = trailing separator.
    // This models the actual Antigravity pattern where the two anchors are distinct.
    const sep = '─'.repeat(48);
    const text = [
      'SESSION 1',
      sep + '\n> ',          // top anchor 1 (sep followed by "> ")
      'old content',
      sep,                   // bottom anchor 1
      'SESSION 2',
      sep + '\n> ',          // top anchor 2 — the LAST one
      'new content here',
      sep,                   // bottom anchor 2
    ].join('\n');

    const spec: VisibleRegionSpec = {
      scope: 'between-anchors',
      anchors: {
        top:    { pattern: '─{40,}\\s*\\n\\s*>\\s*', flags: 'm' },
        bottom: { pattern: '─{40,}\\s*$',            flags: 'm' },
      },
      selectAnchor: 'last',
    };

    const result = applyVisibleRegion(spec, text);
    expect(result).toContain('new content here');
    expect(result).not.toContain('old content');
    expect(result).not.toContain('SESSION 1');
    expect(result).not.toContain('SESSION 2');
  });

  it('antigravity-style anchor pattern correctly scopes a multi-section screen', () => {
    // Antigravity uses `─{40,}\n> ` as the top anchor and `─{40,}$` as bottom.
    const sep = '─'.repeat(48);
    const text = [
      'Previous turn output',
      sep,
      '> ',
      'Old spinner output: Using Tool: Bash',
      sep,
      sep,
      '> ',
      'Thinking…',
      sep,
    ].join('\n');

    const spec: VisibleRegionSpec = {
      $schema: 'adhdev:tui/visible-region@1',
      scope: 'between-anchors',
      anchors: {
        top:    { pattern: '─{40,}\\s*\\n\\s*>\\s*', flags: 'm' },
        bottom: { pattern: '─{40,}\\s*$',           flags: 'm' },
      },
      selectAnchor: 'last',
    };

    const result = applyVisibleRegion(spec, text);
    // Should include Thinking from current frame
    expect(result).toContain('Thinking…');
    // Should NOT include old spinner output from previous frame
    expect(result).not.toContain('Old spinner output');
    expect(result).not.toContain('Previous turn output');
  });
});

describe('applyVisibleRegion — scope: between-anchors, selectAnchor: "first"', () => {
  it('returns text between the FIRST top anchor end and the first bottom after it', () => {
    const text = [
      'HEADER',
      '────────────────────────────────────────',
      'first section content',
      '────────────────────────────────────────',
      'second section content',
      '────────────────────────────────────────',
    ].join('\n');

    const spec: VisibleRegionSpec = {
      scope: 'between-anchors',
      anchors: {
        top:    { pattern: '─{40,}', flags: 'm' },
        bottom: { pattern: '─{40,}', flags: 'm' },
      },
      selectAnchor: 'first',
    };

    const result = applyVisibleRegion(spec, text);
    expect(result).toContain('first section content');
    expect(result).not.toContain('second section content');
    expect(result).not.toContain('HEADER');
  });
});

describe('applyVisibleRegion — anchor not found → full text fallback', () => {
  it('returns full text when top anchor is not present in text', () => {
    const spec: VisibleRegionSpec = {
      scope: 'between-anchors',
      anchors: {
        top: { pattern: 'THIS_ANCHOR_DOES_NOT_EXIST', flags: 'm' },
        bottom: { pattern: '─{40,}', flags: 'm' },
      },
      selectAnchor: 'last',
    };
    const text = 'just some screen content\nno anchors here';
    expect(applyVisibleRegion(spec, text)).toBe(text);
  });

  it('returns full text when bottom anchor is not present in text', () => {
    const spec: VisibleRegionSpec = {
      scope: 'between-anchors',
      anchors: {
        top: { pattern: '─{40,}', flags: 'm' },
        bottom: { pattern: 'THIS_ANCHOR_DOES_NOT_EXIST', flags: 'm' },
      },
      selectAnchor: 'last',
    };
    const text = '────────────────────────────────────────\ncontent\nno bottom anchor';
    expect(applyVisibleRegion(spec, text)).toBe(text);
  });
});

// ─── Integration: detect-status uses visible region ──────────────────────

describe('detect-status — uses visibleRegion when present', () => {
  const sep = '─'.repeat(48);

  // Spec mirrors how antigravity would be built if the daemon reads visibleRegion
  // into DetectStatusTuiSpec.
  const spec: DetectStatusTuiSpec = {
    spinner: {
      $schema: 'adhdev:tui/spinner@1',
      patterns: [
        { regex: '\\bThinking\\b', flags: 'i' },
        { regex: '\\bUsing\\s+Tool\\b', flags: 'i' },
      ],
      scope: 'live-frame-tail',
      scopeWindowLines: 8,
    },
    settledPrompt: {
      $schema: 'adhdev:tui/settled-prompt@1',
      regex: '^>\\s*$',
      flags: 'm',
      withFooter: [{ pattern: '? for shortcuts' }],
      scope: 'last-n-lines',
      scopeWindowLines: 8,
    },
    visibleRegion: {
      $schema: 'adhdev:tui/visible-region@1',
      scope: 'between-anchors',
      anchors: {
        top:    { pattern: '─{40,}\\s*\\n\\s*>\\s*', flags: 'm' },
        bottom: { pattern: '─{40,}\\s*$',           flags: 'm' },
      },
      selectAnchor: 'last',
    },
  };

  const detect = buildDetectStatusFromTui(spec);

  it('returns idle from the scoped current frame, ignoring stale spinner in scrollback', () => {
    // Simulate: previous frame had a spinner; current frame is idle.
    // The top anchor is `sep\n> ` and the bottom anchor is a trailing `sep`.
    // The idle prompt (> / ? for shortcuts) must be INSIDE the scoped region
    // (between top anchor end and bottom anchor start).
    const screen = [
      'old frame:',
      sep + '\n> ',                  // top anchor 1: old frame start
      'Using Tool: Bash',            // old spinner — outside visible region after scoping
      sep,                           // bottom of old frame
      'SESSION 2',
      sep + '\n> ',                  // top anchor 2: current frame start (LAST top anchor)
      'some response',
      '>',                           // idle prompt — inside current frame
      '? for shortcuts',             // footer — inside current frame
      sep,                           // bottom of current frame
    ].join('\n');

    // Without visible-region, the old "Using Tool: Bash" would fire 'generating'.
    // With visible-region scoped to the last frame, it should be 'idle'.
    expect(detect(statusInput(screen))).toBe('idle');
  });

  it('returns generating when spinner is in the current (scoped) frame', () => {
    const screen = [
      'old frame:',
      sep,
      '> ',
      'previous output',
      sep,
      sep,                          // top of current frame
      '> ',
      'Thinking…',
      sep,
    ].join('\n');
    expect(detect(statusInput(screen))).toBe('generating');
  });
});

// ─── Integration: parse-approval uses visible region ─────────────────────

describe('parse-approval — uses visibleRegion when present', () => {
  const sep = '─'.repeat(48);

  const modalSpec: ModalTuiSpec = {
    $schema: 'adhdev:tui/modal@1',
    questionPattern: 'Do you want to proceed\\?',
    questionFlags: 'i',
    buttonPattern: '^>?\\s*\\d+\\.\\s+(.+)$',
    buttonFlags: 'm',
    scope: 'window-around-question',
    scopeWindowLines: 16,
    minButtons: 2,
  };

  const visibleRegion: VisibleRegionSpec = {
    scope: 'between-anchors',
    anchors: {
      top:    { pattern: '─{40,}\\s*\\n\\s*>\\s*', flags: 'm' },
      bottom: { pattern: '─{40,}\\s*$',           flags: 'm' },
    },
    selectAnchor: 'last',
  };

  const parseApproval = buildParseApprovalFromTui(modalSpec, visibleRegion);

  it('extracts the modal from the scoped current frame', () => {
    const screen = [
      'Previous session content',
      sep,
      '> ',
      'old stuff',
      sep,
      sep,                          // start of current frame
      '> ',
      'agy wants to run: ls /tmp',
      'Do you want to proceed?',
      '> 1. Yes, allow once',
      '  2. No, cancel',
      sep,
    ].join('\n');

    const result = parseApproval(approvalInput(screen));
    expect(result).not.toBeNull();
    expect(result?.buttons).toEqual(['Yes, allow once', 'No, cancel']);
    expect(result?.message).toMatch(/Do you want to proceed/i);
  });

  it('returns null when the modal is only in scrollback (outside visible region)', () => {
    const screen = [
      sep,
      '> ',
      'Do you want to proceed?',    // modal in OLD frame
      '> 1. Yes, allow once',
      '  2. No, cancel',
      sep,
      sep,                          // current frame — no modal
      '> ',
      'clean idle frame',
      sep,
    ].join('\n');

    const result = parseApproval(approvalInput(screen));
    // The modal question is outside the visible region, so should be null.
    expect(result).toBeNull();
  });
});
