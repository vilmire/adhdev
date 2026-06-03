/**
 * Provider fixture format — v1.
 *
 * A fixture is two files committed alongside a provider:
 *
 *   fixtures/<scenario>.pty             — raw PTY byte capture (binary or text)
 *   fixtures/<scenario>.expected.json   — expected handler outputs at one
 *                                          or more anchor frames
 *
 * Scenarios cover one concrete agent behaviour: cold start, prompt sent,
 * generating with tool call, approval modal, idle after assistant complete,
 * etc.
 *
 * The replay runner feeds the .pty bytes through the daemon's terminal
 * emulator (TerminalTranscriptAccumulator) building up snapshots at each
 * declared anchor, invokes the provider handlers, and compares results
 * to the .expected.json shape.
 *
 * This file is the source of truth for the format. Schema mirror at
 * sdk/v1/schemas/fixture-expected.schema.json.
 */

import type {
  CliApprovalModal,
  CliChatMessage,
  CliStatus,
} from '../types/cli/index.js';

/**
 * The top-level shape of <scenario>.expected.json.
 *
 * `anchors` is an ordered list; each anchor declares a point in the
 * PTY stream (by byte offset or by sentinel string) and the expected
 * handler outputs at that point.
 */
export interface FixtureExpected {
  /** Schema version. Currently always 1. */
  version: 1;
  /** Free-form human description of the scenario. */
  description?: string;
  /** Provider type this fixture is for. */
  providerType: string;
  /** Path (relative to the .expected.json file) of the corresponding .pty file. */
  ptyFile: string;
  /** Optional cols/rows the recording was captured under. Defaults to 80x24. */
  terminal?: { cols: number; rows: number };
  /** Anchor points. Order matters; bytes are replayed up to each anchor. */
  anchors: FixtureAnchor[];
}

export interface FixtureAnchor {
  /** Human-readable identifier. Used in test reporter output. */
  name: string;
  /** Optional description. */
  description?: string;
  /**
   * Where to stop replaying bytes. Exactly one of:
   *   - `untilByte` — stop after the Nth raw byte
   *   - `untilSentinel` — stop the first time `sentinel` appears in the
   *     accumulated rendered screen text
   */
  untilByte?: number;
  untilSentinel?: string;
  /**
   * Expected handler outputs. All keys optional; the replay runner only
   * checks the keys you provide.
   */
  expect: {
    detectStatus?: CliStatus | null;
    parseApproval?: CliApprovalModal | null;
    parseSession?: {
      status?: CliStatus;
      modal?: CliApprovalModal | null;
      providerSessionId?: string;
      /**
       * Either an exact array (deep-equal) or a shape declaration that lets
       * you match only the role/kind/content shape without pinning specific
       * fields. Pin specific message-by-message when you care about content.
       */
      messages?: CliChatMessage[] | MessageShape[];
    };
  };
  /**
   * Optional notes about why this anchor exists. Encouraged for
   * regression-style fixtures so future maintainers know what bug the
   * fixture catches.
   */
  notes?: string;
}

/**
 * A shape declaration that matches a message by role/kind plus optional
 * content substring or regex. Use this instead of an exact CliChatMessage
 * when you do not want to pin exact text.
 */
export interface MessageShape {
  role: CliChatMessage['role'];
  kind?: CliChatMessage['kind'];
  /** Substring the content must contain. Plain string only. */
  contentIncludes?: string;
  /** Regex the content must match. */
  contentMatches?: { source: string; flags?: string };
}

/**
 * Result of replaying one anchor — what the handlers actually emitted.
 * Used by the test runner to produce diff output.
 */
export interface AnchorReplayResult {
  anchor: FixtureAnchor;
  passes: boolean;
  diffs: string[];
  actual: {
    detectStatus?: CliStatus | null;
    parseApproval?: CliApprovalModal | null;
    parseSession?: {
      status: CliStatus;
      modal: CliApprovalModal | null;
      providerSessionId?: string;
      messages: CliChatMessage[];
    };
  };
}

export interface FixtureReplayResult {
  fixturePath: string;
  expected: FixtureExpected;
  perAnchor: AnchorReplayResult[];
  overallPasses: boolean;
}
