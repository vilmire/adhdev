/**
 * Fixture replay runner.
 *
 * Given a `.pty` byte capture and `.expected.json` declaration, replay the
 * bytes through the daemon's TerminalTranscriptAccumulator, invoke the
 * provider handlers at each anchor, and diff against expectations.
 *
 * Used by:
 *   - `adhdev provider test` (daemon-cloud CLI)
 *   - daemon-core CI suite for production-provider regression tests
 *   - external authors as `adhdev provider test ./`
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  TerminalTranscriptAccumulator,
  buildCliScreenSnapshot,
  type CliScriptInput as InternalCliScriptInput,
  type CliStatusInput as InternalCliStatusInput,
  type CliApprovalInput as InternalCliApprovalInput,
  type ParsedSession as InternalParsedSession,
} from '../../../../cli-adapters/provider-cli-shared.js';
import type {
  CliApprovalModal,
  CliChatMessage,
  CliStatus,
} from '../types/cli/index.js';
import type {
  FixtureExpected,
  FixtureAnchor,
  AnchorReplayResult,
  FixtureReplayResult,
  MessageShape,
} from './format.js';

// ─── Provider handler shape (matches the contract) ─────────────────────

export interface CliProviderHandlers {
  createState?: () => Record<string, unknown>;
  parseSession: (state: unknown, input: InternalCliScriptInput) => InternalParsedSession;
  detectStatus: (input: InternalCliStatusInput) => string | null;
  parseApproval: (input: InternalCliApprovalInput) => { message: string; buttons: string[] } | null;
  parseOutput?: (state: unknown, input: InternalCliScriptInput) => unknown;
}

export interface ReplayOptions {
  /** Override accumulator dimensions. Defaults to the fixture's terminal block or 80x24. */
  cols?: number;
  rows?: number;
  /** Provided manually (e.g. by tests). Defaults to wall-clock at replay start. */
  spawnAt?: number;
}

// ─── Helpers — build the inputs the handlers expect ────────────────────

function makeStatusInput(buffer: string, rawBuffer: string): InternalCliStatusInput {
  const tail = buffer.slice(-1000);
  const screenText = buffer;
  return {
    tail,
    screenText,
    rawBuffer,
    isWaitingForResponse: false,
    screen: buildCliScreenSnapshot(screenText),
    tailScreen: buildCliScreenSnapshot(tail),
  };
}

function makeApprovalInput(buffer: string, rawBuffer: string): InternalCliApprovalInput {
  const tail = buffer.slice(-1000);
  const screenText = buffer;
  return {
    buffer,
    screenText,
    rawBuffer,
    tail,
    screen: buildCliScreenSnapshot(screenText),
    bufferScreen: buildCliScreenSnapshot(buffer),
    tailScreen: buildCliScreenSnapshot(tail),
  };
}

function makeScriptInput(
  buffer: string,
  rawBuffer: string,
  spawnAt: number,
): InternalCliScriptInput {
  const recentBuffer = buffer.slice(-1000);
  const screenText = buffer;
  return {
    buffer,
    rawBuffer,
    recentBuffer,
    screenText,
    screen: buildCliScreenSnapshot(screenText),
    bufferScreen: buildCliScreenSnapshot(buffer),
    recentScreen: buildCliScreenSnapshot(recentBuffer),
    messages: [],
    partialResponse: '',
    isWaitingForResponse: false,
    spawnAt,
  };
}

// ─── Anchor stop condition ─────────────────────────────────────────────

function nextStopIndex(anchor: FixtureAnchor, startIdx: number, raw: string): number {
  if (typeof anchor.untilByte === 'number') {
    return Math.min(anchor.untilByte, raw.length);
  }
  if (anchor.untilSentinel) {
    const idx = raw.indexOf(anchor.untilSentinel, startIdx);
    return idx < 0 ? raw.length : idx + anchor.untilSentinel.length;
  }
  // Default: replay everything.
  return raw.length;
}

// ─── Shape matching for messages ───────────────────────────────────────

function isShapeArray(input: unknown): input is MessageShape[] {
  if (!Array.isArray(input) || input.length === 0) return false;
  return input.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const keys = Object.keys(m as object);
    // Detect by absence of CliChatMessage-only required fields like `content` typed string.
    return (
      keys.some((k) => k === 'contentIncludes' || k === 'contentMatches') ||
      (keys.includes('role') && !keys.includes('content'))
    );
  });
}

function messageMatchesShape(actual: CliChatMessage, shape: MessageShape): string | null {
  if (actual.role !== shape.role) {
    return `role mismatch: expected "${shape.role}", got "${actual.role}"`;
  }
  if (shape.kind && actual.kind && actual.kind !== shape.kind) {
    return `kind mismatch: expected "${shape.kind}", got "${actual.kind}"`;
  }
  const content = typeof actual.content === 'string'
    ? actual.content
    : JSON.stringify(actual.content);
  if (shape.contentIncludes && !content.includes(shape.contentIncludes)) {
    return `content missing substring "${shape.contentIncludes.slice(0, 40)}"`;
  }
  if (shape.contentMatches) {
    const re = new RegExp(shape.contentMatches.source, shape.contentMatches.flags ?? '');
    if (!re.test(content)) {
      return `content does not match /${shape.contentMatches.source}/${shape.contentMatches.flags ?? ''}`;
    }
  }
  return null;
}

// ─── Diffing ───────────────────────────────────────────────────────────

function diffStatus(
  label: string,
  expected: unknown,
  actual: unknown,
  diffs: string[],
): void {
  if (expected === undefined) return;
  if (expected !== actual) {
    diffs.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function diffModal(
  label: string,
  expected: CliApprovalModal | null | undefined,
  actual: CliApprovalModal | null,
  diffs: string[],
): void {
  if (expected === undefined) return;
  if (expected === null) {
    if (actual !== null) {
      diffs.push(`${label}: expected null modal, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (actual === null) {
    diffs.push(`${label}: expected modal, got null`);
    return;
  }
  if (expected.message !== actual.message) {
    diffs.push(`${label}.message: expected "${expected.message}", got "${actual.message}"`);
  }
  if (expected.buttons.length !== actual.buttons.length) {
    diffs.push(`${label}.buttons.length: expected ${expected.buttons.length}, got ${actual.buttons.length}`);
  } else {
    for (let i = 0; i < expected.buttons.length; i += 1) {
      if (expected.buttons[i] !== actual.buttons[i]) {
        diffs.push(`${label}.buttons[${i}]: expected "${expected.buttons[i]}", got "${actual.buttons[i]}"`);
      }
    }
  }
}

function diffMessages(
  label: string,
  expected: CliChatMessage[] | MessageShape[] | undefined,
  actual: CliChatMessage[],
  diffs: string[],
): void {
  if (expected === undefined) return;
  if (expected.length !== actual.length) {
    diffs.push(`${label}.length: expected ${expected.length}, got ${actual.length}`);
    return;
  }
  if (isShapeArray(expected)) {
    for (let i = 0; i < expected.length; i += 1) {
      const reason = messageMatchesShape(actual[i], expected[i] as MessageShape);
      if (reason) diffs.push(`${label}[${i}]: ${reason}`);
    }
  } else {
    for (let i = 0; i < expected.length; i += 1) {
      const e = expected[i] as CliChatMessage;
      const a = actual[i];
      if (e.role !== a.role) diffs.push(`${label}[${i}].role: ${e.role} vs ${a.role}`);
      const ec = typeof e.content === 'string' ? e.content : JSON.stringify(e.content);
      const ac = typeof a.content === 'string' ? a.content : JSON.stringify(a.content);
      if (ec !== ac) diffs.push(`${label}[${i}].content: differs`);
    }
  }
}

// ─── Replay one anchor ─────────────────────────────────────────────────

function replayAnchor(
  raw: string,
  startIdx: number,
  acc: TerminalTranscriptAccumulator,
  anchor: FixtureAnchor,
  handlers: CliProviderHandlers,
  spawnAt: number,
): { result: AnchorReplayResult; nextIdx: number } {
  const stop = nextStopIndex(anchor, startIdx, raw);
  const chunk = raw.slice(startIdx, stop);
  const buffer = acc.append(chunk);
  const rawBufferSnapshot = raw.slice(0, stop);

  const detect = handlers.detectStatus(makeStatusInput(buffer, rawBufferSnapshot));
  const modal = handlers.parseApproval(makeApprovalInput(buffer, rawBufferSnapshot));
  const state = handlers.createState ? handlers.createState() : undefined;
  const session = handlers.parseSession(state, makeScriptInput(buffer, rawBufferSnapshot, spawnAt));

  const diffs: string[] = [];
  diffStatus('detectStatus', anchor.expect.detectStatus, detect as CliStatus | null, diffs);
  diffModal('parseApproval', anchor.expect.parseApproval, modal, diffs);
  if (anchor.expect.parseSession) {
    diffStatus('parseSession.status', anchor.expect.parseSession.status, session.status as CliStatus, diffs);
    diffModal('parseSession.modal', anchor.expect.parseSession.modal, session.modal as CliApprovalModal | null, diffs);
    if (anchor.expect.parseSession.providerSessionId !== undefined) {
      diffStatus(
        'parseSession.providerSessionId',
        anchor.expect.parseSession.providerSessionId,
        session.providerSessionId,
        diffs,
      );
    }
    diffMessages(
      'parseSession.messages',
      anchor.expect.parseSession.messages,
      session.messages as CliChatMessage[],
      diffs,
    );
  }

  return {
    result: {
      anchor,
      passes: diffs.length === 0,
      diffs,
      actual: {
        detectStatus: detect as CliStatus | null,
        parseApproval: modal,
        parseSession: {
          status: session.status as CliStatus,
          modal: session.modal as CliApprovalModal | null,
          providerSessionId: session.providerSessionId,
          messages: session.messages as CliChatMessage[],
        },
      },
    },
    nextIdx: stop,
  };
}

// ─── Public API ────────────────────────────────────────────────────────

export function loadFixtureExpected(expectedPath: string): FixtureExpected {
  const raw = readFileSync(expectedPath, 'utf-8');
  const parsed = JSON.parse(raw) as FixtureExpected;
  if (parsed.version !== 1) {
    throw new Error(`Fixture format version ${parsed.version} not supported (this runner is v1).`);
  }
  if (!parsed.providerType) throw new Error('Fixture missing providerType');
  if (!parsed.ptyFile) throw new Error('Fixture missing ptyFile');
  if (!Array.isArray(parsed.anchors) || parsed.anchors.length === 0) {
    throw new Error('Fixture must declare at least one anchor');
  }
  return parsed;
}

export function replayFixture(
  expectedPath: string,
  handlers: CliProviderHandlers,
  options: ReplayOptions = {},
): FixtureReplayResult {
  const expected = loadFixtureExpected(expectedPath);
  const ptyFullPath = resolve(dirname(expectedPath), expected.ptyFile);
  const rawBytes = readFileSync(ptyFullPath, 'utf-8');
  const acc = new TerminalTranscriptAccumulator();
  const spawnAt = options.spawnAt ?? Date.now();
  let idx = 0;
  const perAnchor: AnchorReplayResult[] = [];
  for (const anchor of expected.anchors) {
    const { result, nextIdx } = replayAnchor(rawBytes, idx, acc, anchor, handlers, spawnAt);
    perAnchor.push(result);
    idx = nextIdx;
  }
  return {
    fixturePath: expectedPath,
    expected,
    perAnchor,
    overallPasses: perAnchor.every((a) => a.passes),
  };
}

/**
 * Format a result as a human-readable report. Returns the multi-line string;
 * caller decides whether to print or assert.
 */
export function formatReplayReport(result: FixtureReplayResult): string {
  const lines: string[] = [];
  lines.push(`Fixture: ${result.fixturePath}`);
  lines.push(`Provider: ${result.expected.providerType}`);
  lines.push(`Anchors: ${result.perAnchor.length}`);
  for (const a of result.perAnchor) {
    if (a.passes) {
      lines.push(`  ✓ ${a.anchor.name}`);
    } else {
      lines.push(`  ✗ ${a.anchor.name}`);
      for (const d of a.diffs) lines.push(`      ${d}`);
    }
  }
  lines.push(result.overallPasses ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  return lines.join('\n');
}
