/**
 * Extract assistant messages from an antigravity-cli PTY screen.
 *
 * Antigravity (agy) idle transcript after a completed turn looks like:
 *
 *   > user prompt
 *     1. numbered continuation of the user echo
 *   ▸ Thought for 12s, 1840 tokens
 *     Prioritizing Tool Usage
 *   ● Bash(...) (ctrl+o to expand)
 *   ● Bash(...)
 *     {
 *       "status": "completed",
 *       ...
 *     }
 *
 * The `● Tool(` rows are TOOL CALLS, not assistant prose (kimi uses `●` for
 * assistant answers — do not copy that prefix here). The assistant's final
 * reply is the indented body under the tool list, often a JSON report for
 * mesh workers.
 *
 * Live defect (M-MESH-INFRA-0829 #2, 2026-08-29): SpecCliAdapter's PTY parser
 * was Claude-only (`⏺`) and native_history.reader snapshots were never
 * consulted, so Last Assistant was blank while this JSON sat on screen and
 * the fail-closed completion gate held the mesh turn in generating.
 */
'use strict';

import type { ChatMessage } from '../../types.js';

const USER_RE = /^>\s+(\S.*)$/;
const EMPTY_COMPOSER_RE = /^>\s*$/;
const TOOL_RE = /^●\s+\S+/;
const THOUGHT_RE = /^▸\s/;
const RULE_RE = /^[─━═\-]{3,}\s*$/;
const JSON_START_RE = /^\s*[{\[]/;

const CHROME_RES: readonly RegExp[] = [
  RULE_RE,
  EMPTY_COMPOSER_RE,
  /^\s*\? for shortcuts/,
  /esc to cancel/i,
  /^Resume:\s+agy\b/i,
  /^Antigravity CLI\b/,
  /\(Google AI (?:Ultra|Pro|Free)\)/,
  /^\s*↑\/↓\s+Navigate/,
  /^Requesting permission for:/,
  /^Do you want to proceed\?/,
  /^Accept this file edit\?/,
  /^Allow (?:access to|creation of) this file\?/,
  /^Allow sandbox bypass/,
  /^Command\s*$/,
];

function isChrome(line: string): boolean {
  for (const re of CHROME_RES) {
    if (re.test(line)) return true;
  }
  return false;
}

function isIndented(line: string): boolean {
  return /^\s+\S/.test(line);
}

function assistantMessage(content: string): ChatMessage {
  return {
    role: 'assistant',
    kind: 'standard',
    content,
    source: 'assistant_text',
    userFacing: true,
    bubbleState: 'final',
  };
}

/**
 * Parse one idle (or busy) antigravity screen into assistant bubbles.
 * User echoes and tool rows are skipped; only the post-tool answer body
 * (indented JSON / prose) is returned. Empty when the frame has no
 * user-visible assistant text — callers must fail closed.
 */
export function extractAntigravityScreenAssistantMessages(screenText: string): ChatMessage[] {
  const lines = String(screenText || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const messages: ChatMessage[] = [];
  // Loop-carried: true once a `● Tool` row has been seen in this frame,
  // until a new user echo. TS control-flow cannot see this across
  // iterations if it is encoded only as a `role` discriminant.
  let afterTool = false;
  let inUser = false;
  let inThought = false;
  let seenRole = false;

  const pushOrAppendAssistant = (text: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && typeof last.content === 'string') {
      last.content = last.content ? `${last.content}\n${text}` : text;
    } else {
      messages.push(assistantMessage(text));
    }
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (isChrome(line)) continue;

    if (USER_RE.test(line)) {
      inUser = true;
      inThought = false;
      afterTool = false;
      seenRole = true;
      continue;
    }
    if (TOOL_RE.test(line)) {
      inUser = false;
      inThought = false;
      afterTool = true;
      seenRole = true;
      continue;
    }
    if (THOUGHT_RE.test(line)) {
      inUser = false;
      inThought = true;
      seenRole = true;
      continue;
    }

    if (!seenRole) continue;
    if (inUser && isIndented(line)) continue;
    if (inThought && isIndented(line) && !JSON_START_RE.test(line) && !afterTool) continue;

    if (afterTool || (inThought && JSON_START_RE.test(line))) {
      const text = line.replace(/^\s+/, '');
      if (text) {
        pushOrAppendAssistant(text);
        inThought = false;
        inUser = false;
      }
    }
  }

  return messages.filter((m) => typeof m.content === 'string' && m.content.trim().length > 0);
}
