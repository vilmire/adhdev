/**
 * antigravity-cli step-payload protobuf decoding: a tiny dependency-free
 * protobuf field walker plus the empirically-mapped field paths for user
 * prompts, model answers/reasoning, tool calls, tool results and background
 * task notifications (see antigravity-cli-transcript.ts for the store layout).
 * Also the legacy `.pb` printable-run extraction.
 *
 * Split out of antigravity-cli-transcript.ts (file-size gate). Pure functions
 * over Buffers — no filesystem or database access.
 */
import * as fs from 'fs';
import { oneLine, TOOL_CALL_SUMMARY_MAX } from '../spec/native-history-tool-blocks.js';
import type { NativeHistoryMessage } from './antigravity-cli-transcript.js';
import { statMtimeMs } from './fs-utils.js';

// ─── Protobuf best-effort text extraction ────────────────────────────────────

const MIN_PRINTABLE_RUN = 8;

/**
 * Extract printable UTF-8 text runs from raw binary data (similar to the `strings` command).
 * Runs of printable ASCII/UTF-8 characters of length >= MIN_PRINTABLE_RUN are collected.
 * This is used as a best-effort fallback when the .pb schema is not available.
 */
function extractStringsFromBuffer(buf: Buffer): string[] {
  const strings: string[] = [];
  let current: number[] = [];

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    // Accept printable ASCII (32-126) and common whitespace (9=tab, 10=LF, 13=CR)
    if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
      current.push(byte);
    } else {
      if (current.length >= MIN_PRINTABLE_RUN) {
        const str = Buffer.from(current).toString('utf-8').trim();
        if (str) strings.push(str);
      }
      current = [];
    }
  }
  // Flush remaining
  if (current.length >= MIN_PRINTABLE_RUN) {
    const str = Buffer.from(current).toString('utf-8').trim();
    if (str) strings.push(str);
  }

  return strings;
}

/**
 * Read a .pb conversation file and extract best-effort text content.
 * Returns a single NativeHistoryMessage with the extracted content,
 * or null if nothing readable was found.
 */
export function parsePbFile(
  filePath: string,
  sessionId: string,
): NativeHistoryMessage[] | null {
  let buf: Buffer;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  if (buf.length === 0) return null;

  const strings = extractStringsFromBuffer(buf);
  // Filter out very short or likely-binary strings
  const meaningful = strings.filter((s) => s.length >= MIN_PRINTABLE_RUN && /\w/.test(s));
  if (meaningful.length === 0) return null;

  const content = meaningful.join('\n');
  const sourceMtimeMs = statMtimeMs(filePath);

  return [
    {
      ts: new Date(sourceMtimeMs).toISOString(),
      receivedAt: sourceMtimeMs,
      role: 'assistant',
      content,
      kind: 'standard',
      agent: 'antigravity-cli',
      historySessionId: sessionId,
    },
  ];
}

// ─── SQLite (.db) conversation reader ────────────────────────────────────────
//
// Recent antigravity stores each conversation in a per-session SQLite db at
// conversations/<uuid>.db. See the file header for the schema. We decode the
// protobuf `step_payload` blobs with a minimal, dependency-free field walker —
// we only need two leaf strings (user prompt / assistant answer), so a full
// proto schema is unnecessary.

/** Antigravity step_type values that map to a chat message. */
export const AGY_STEP_TYPE_USER = 14;
export const AGY_STEP_TYPE_MODEL = 15;

/**
 * (ANTIGRAVITY-STEPS-STATUS-COMPLETION) `steps.status` value meaning SETTLED —
 * the step is finished and its step_payload is complete.
 *
 * Antigravity writes a model step INCREMENTALLY. The row first appears with
 * status 8 (in-flight) carrying a truncated step_payload that grows on every
 * flush, then flips to status 3 with the complete answer — reusing the SAME
 * `idx`. Reading a status-8 row therefore hands out a half-written answer as if
 * it were the model's final word, and since the settled row carries the same
 * (providerSessionId, idx) identity, the partial and the full text collided
 * downstream instead of the latter replacing the former.
 *
 * Live capture of a 199s turn (agy 1.1.11), store polled every 400ms:
 *   t=189.3s  idx7 ty15 st8   247B   ← partial
 *   t=195.8s  idx7 ty15 st8  2268B   ← same row, grown
 *   t=199.1s  idx7 ty15 st3  3529B   ← settled, complete
 *
 * Filtering to status 3 costs no coverage: across 289 real conversation stores,
 * every settled step_type 14/15 row holds status 3 and nothing else (456 user +
 * 2260 model rows, zero exceptions). The other observed values — 2 (running),
 * 6, 7 (awaiting approval) — occur ONLY on tool step types, which this reader
 * does not select anyway. So no user-visible message is withheld by this filter;
 * the only rows it removes are turns still being written.
 *
 * This also brings the .db reader in line with its sibling: parseBrainTranscript
 * has always required `row.status === 'DONE'`. The .db path was the outlier.
 */
export const AGY_STATUS_DONE = 3;

interface ProtoField {
  field: number;
  wireType: number;
  /** For wireType 2 (length-delimited): the raw bytes. */
  bytes?: Buffer;
  /** For wireType 0 (varint): the value. */
  varint?: number;
}

/**
 * Read a base-128 varint starting at `offset`. Returns [value, nextOffset].
 * Values are read as JS numbers (safe: the fields we consume are small).
 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 63) break; // malformed / oversized
  }
  return [result, i];
}

/**
 * Decode the top-level fields of a protobuf message. Best-effort: stops on the
 * first malformed byte rather than throwing, so a partially-corrupt blob still
 * yields the fields decoded so far.
 */
export function decodeProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    if (afterKey === i) break;
    i = afterKey;
    const field = Math.floor(key / 8);
    const wireType = key & 7;
    if (field <= 0) break;
    if (wireType === 0) {
      const [value, next] = readVarint(buf, i);
      if (next === i) break;
      i = next;
      fields.push({ field, wireType, varint: value });
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(buf, i);
      i = afterLen;
      if (len < 0 || i + len > buf.length) break;
      fields.push({ field, wireType, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      break; // wireType 3/4 (groups) — unused by antigravity payloads
    }
  }
  return fields;
}

/** Return the bytes of the first length-delimited field with number `field`. */
export function firstLenField(buf: Buffer, field: number): Buffer | null {
  for (const f of decodeProtoFields(buf)) {
    if (f.field === field && f.wireType === 2 && f.bytes) return f.bytes;
  }
  return null;
}

/** Heuristic: is this buffer (mostly) printable UTF-8 text? */
function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // ASCII printable + common whitespace, or any high byte (UTF-8 lead/cont).
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13 || b >= 0x80) printable += 1;
  }
  return printable / buf.length >= 0.9;
}

/**
 * Antigravity prefixes some assistant answers with a literal `MARKER_V1`
 * sentinel followed by a blank line. Strip it so the user-visible bubble starts
 * at the real text.
 */
function stripAnswerMarker(text: string): string {
  return text.replace(/^\s*MARKER_V1\s*/, '');
}

/**
 * Extract the assistant's final natural-language answer from a step_type 15
 * payload: field 20 → field 1 (identical to field 8). Field 20 → field 3 is the
 * private reasoning summary and is deliberately skipped. Returns '' if absent
 * (e.g. a pure reasoning / tool-only model step, which carries no user-visible
 * answer text).
 */
export function extractModelAnswer(payload: Buffer): string {
  const inner = firstLenField(payload, 20);
  if (!inner) return '';
  const answer = firstLenField(inner, 1) ?? firstLenField(inner, 8);
  if (!answer || !looksLikeText(answer)) return '';
  return stripAnswerMarker(answer.toString('utf-8')).trim();
}

/**
 * Extract the user prompt from a step_type 14 payload: field 19 → field 2 (the
 * clean prompt text; field 19 → field 3 wraps the same string with a leading
 * newline and is used only as a fallback). The USER_REQUEST XML wrapper, when
 * present, is unwrapped to match the brain-transcript reader's output.
 */
export function extractUserPrompt(payload: Buffer): string {
  const inner = firstLenField(payload, 19);
  if (!inner) return '';
  const raw = firstLenField(inner, 2) ?? firstLenField(inner, 3);
  if (!raw || !looksLikeText(raw)) return '';
  const text = raw.toString('utf-8').trim();
  if (!text) return '';
  return extractUserRequestContent(text);
}

/**
 * The model step's private reasoning summary lives at field 20 → field 3. We
 * surface it nowhere, but we DO need it: the schema-drift recovery below scans
 * the raw payload for a plausible answer run, and the reasoning is itself a long
 * natural-language run — so we extract it here purely to EXCLUDE it and avoid
 * accidentally surfacing internal reasoning as the assistant answer.
 */
export function extractModelReasoning(payload: Buffer): string {
  const inner = firstLenField(payload, 20);
  if (!inner) return '';
  const reasoning = firstLenField(inner, 3);
  if (!reasoning || !looksLikeText(reasoning)) return '';
  return reasoning.toString('utf-8').trim();
}

/** Top-level protobuf field numbers present in a payload (for drift breadcrumbs). */
export function topLevelFieldNumbers(payload: Buffer): number[] {
  return decodeProtoFields(payload).map((f) => f.field);
}

const MIN_RECOVERED_MESSAGE_CHARS = 12;

/**
 * Split a payload into UTF-8 text runs, schema-agnostically. Unlike
 * extractStringsFromBuffer (ASCII-only, used for legacy .pb), this is UTF-8 aware
 * so CJK / accented answers survive intact: we decode the whole blob as UTF-8
 * (invalid byte sequences collapse to U+FFFD) and split on runs of C0/C1 control
 * chars + the replacement char. Protobuf framing bytes (field tags, varint length
 * prefixes) are almost always control or invalid-UTF-8, so each natural-language
 * string field emerges as its own run while binary framing is discarded.
 */
function extractUtf8TextRuns(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const decoded = buf.toString('utf-8');
  // Keep tab/newline/CR (0x09/0x0A/0x0D) inside runs — answers contain newlines.
  // Everything else in C0 (incl. 0x1A, the field-3 tag that separates reasoning
  // from the answer), DEL, and the replacement char are run separators.
  const parts = decoded.split(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]+/);
  const runs: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length >= MIN_PRINTABLE_RUN) runs.push(trimmed);
  }
  return runs;
}

/**
 * Is this run plausibly a user-visible prose message, as opposed to the other
 * text the payload also carries — internal reasoning (excluded separately),
 * tool-call JSON arguments, code blobs, file paths, and uuid/session-id
 * metadata? These filters were tuned against real antigravity stores so that a
 * blind printable-run scan recovers a genuinely drifted answer while surfacing
 * NONE of the tool-call / metadata runs that legitimately answer-less steps
 * carry (verified: zero false recoveries across real conversation dbs).
 */
function isPlausibleMessageText(s: string): boolean {
  if (s.length < MIN_RECOVERED_MESSAGE_CHARS) return false;
  if (!/[A-Za-zÀ-￿]/.test(s)) return false; // must contain letters (incl. CJK)
  if (/^(file:\/\/|[A-Za-z]:[\\/]|\/[A-Za-z0-9._-]+\/)/.test(s)) return false; // path/URI
  // Prose is multi-word: real answers have several spaces; uuids / ids / tokens
  // have none. This is the single strongest prose-vs-metadata discriminator.
  if ((s.match(/ /g) ?? []).length < 2) return false;
  // Reject structured tool-call args / JSON / code blobs. A model tool step
  // carries its arguments as JSON (e.g. {"Query":...}, {"CommandLine":...});
  // those must never be surfaced as an assistant answer.
  if (/[[{]\s*"/.test(s)) return false;
  const structural = (s.match(/[{}[\]":\\]/g) ?? []).length;
  if (structural / s.length > 0.12) return false;
  return true;
}

/**
 * Schema-agnostic recovery of a message's text when the known field path yields
 * nothing (a possible antigravity step_payload schema drift). Scans the payload
 * for UTF-8 text runs and returns the longest plausible message run, EXCLUDING
 * any run that matches one of `excludeTexts` (e.g. the reasoning subtree) so we
 * never surface internal reasoning as the answer. Returns '' when nothing beyond
 * reasoning/metadata is present — i.e. a legitimately answer-less step.
 */
export function recoverMessageText(payload: Buffer, excludeTexts: string[]): string {
  const exclusions = excludeTexts.map((t) => t.trim()).filter(Boolean);
  let best = '';
  for (const run of extractUtf8TextRuns(payload)) {
    const candidate = stripAnswerMarker(run).trim();
    if (!isPlausibleMessageText(candidate)) continue;
    // Drop runs that are (or are contained in / contain) an excluded subtree.
    if (exclusions.some((e) => e === candidate || e.includes(candidate) || candidate.includes(e))) {
      continue;
    }
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

// ─── Tool steps (call / result / task notification) ──────────────────────────
//
// (AGY-TOOL-BUBBLES) Decoded shapes, measured across every real store on the
// dev Mac (291 conversations; 4,666 tool-execution rows):
//
//   CALL — carried by the MODEL step (step_type 15) that decided to call it, at
//     field 20 → field 7 (REPEATED: 154 model steps issue parallel calls):
//       20.7.1 call id ("call_2069159" / "6j9mkaph")
//       20.7.2 tool name ("run_command", "view_file", "grep_search", …)
//       20.7.3 arguments, a JSON object string ({"CommandLine":…,"Cwd":…})
//       20.7.7 opaque signature blob (never surfaced)
//     A model step that only calls a tool has NO answer at 20.1/20.8 — which is
//     why this reader used to drop it and show nothing for the whole tool turn.
//
//   RESULT — one EXECUTION step per call, at a later idx. The step_type is
//     per-tool (132 generic, 21 run_command, 8 view_file, 7 grep_search, 9
//     list_dir, 5 write_to_file, 17 invalid-call, 25 find_by_name, 38
//     call_mcp_tool, …), so it is recognised by SHAPE, not by step_type: every
//     execution step repeats the call at field 5 → field 4 (same 1/2/3 layout).
//     Pairing is exact — 4,666/4,666 execution steps match a model-step call
//     id, 0 unmatched either way, and the execution always has the larger idx.
//     Output location:
//       - generic (field 140): 140.2.1 is the tool's text result
//         ("The command exited with code 0.\nOutput:\n…"); 140.2.6 embeds a
//         whole copy of the Step (args included) and is never read.
//       - per-tool legacy fields (14 view_file, 13 grep_search, 28
//         run_command, 47 call_mcp_tool, 24 invalid call, …): heterogeneous
//         sub-messages; the longest text leaf is the result body (file
//         contents, grep output, mcp response, command output).
//     Failure: status 4 (invalid args), 6 (failed/cancelled), 7 (denied) carry
//     `error_details` (field 1 = one-line message) and/or payload field 31.
//     Status 2 (running) has no result yet and is skipped until it settles.
//
//   TASK NOTIFICATION — step_type 101, field 114: 114.2.1 title ("Wait for
//     task: Timer has expired"), 114.2.{2,10} body, 114.3 = "task_notification".
//     Injected by antigravity when a background task (async run_command /
//     schedule timer) resolves.
//
// Every one of these becomes a `kind:'tool'` assistant bubble — an ACTIVITY
// message (chat-message-normalization isActivityKind), so it never satisfies
// the completion gate's "final assistant message" test and never becomes a
// session preview.

/** High-volume non-tool step types, excluded in SQL purely to save IO:
 *  90 = EPHEMERAL_MESSAGE system reminders, 98 = empty context marker. Anything
 *  else is admitted and recognised by shape (field 5 → 4 call header). */
export const AGY_STEP_TYPES_NEVER_TOOL = [90, 98];
/** Execution-step statuses that carry a settled result. 2 (running) does not. */
const AGY_TOOL_SETTLED_STATUSES = new Set([3, 4, 6]);
/** Status 7 settles only when it carries an error (observed: 53/53 do). */
const AGY_STATUS_DENIED = 7;
/** Top-level execution-step fields that are header/metadata, never output. */
const AGY_TOOL_STEP_NON_OUTPUT_FIELDS = new Set([1, 2, 3, 4, 5, 31, 56, 133, 140, 147, 148]);
/** Argument keys that are antigravity UI hints, not arguments. */
const AGY_UI_ONLY_ARG_KEYS = ['toolAction', 'toolSummary'];

interface AgyToolCall {
  name: string;
  argsJson: string;
}

/** Every length-delimited field `field` in `buf`, in wire order. */
function allLenFields(buf: Buffer, field: number): Buffer[] {
  const out: Buffer[] = [];
  for (const f of decodeProtoFields(buf)) {
    if (f.field === field && f.wireType === 2 && f.bytes) out.push(f.bytes);
  }
  return out;
}

/** Text of the first length-delimited field `field`, or null. */
function textField(buf: Buffer | null, field: number): string | null {
  if (!buf) return null;
  const bytes = firstLenField(buf, field);
  if (!bytes || bytes.length === 0 || !looksLikeText(bytes)) return null;
  return bytes.toString('utf-8');
}

/** Decode a call record (20.7 / 5.4 layout). Null unless it names a tool. */
function decodeToolCall(buf: Buffer | null): AgyToolCall | null {
  const name = textField(buf, 2)?.trim();
  if (!name) return null;
  return { name, argsJson: (textField(buf, 3) ?? '').trim() };
}

/** Tool calls a MODEL step issued, in order (field 20 → 7, repeated). */
export function extractModelToolCalls(payload: Buffer): AgyToolCall[] {
  const inner = firstLenField(payload, 20);
  if (!inner) return [];
  const calls: AgyToolCall[] = [];
  for (const raw of allLenFields(inner, 7)) {
    const call = decodeToolCall(raw);
    if (call) calls.push(call);
  }
  return calls;
}

/**
 * Strict protobuf decode: succeeds only when the WHOLE buffer parses as a
 * message. Used to tell a sub-message from a text leaf when walking the
 * heterogeneous per-tool result fields — the lenient decodeProtoFields would
 * happily "decode" the first few bytes of a text string.
 */
function decodeProtoStrict(buf: Buffer): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    if (afterKey === i || afterKey > buf.length) return null;
    i = afterKey;
    const field = Math.floor(key / 8);
    const wireType = key & 7;
    if (field <= 0 || field > 1000) return null;
    if (wireType === 0) {
      const [value, next] = readVarint(buf, i);
      if (next === i || next > buf.length || (buf[next - 1] & 0x80) !== 0) return null;
      i = next;
      fields.push({ field, wireType, varint: value });
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(buf, i);
      if (afterLen === i || afterLen + len > buf.length) return null;
      fields.push({ field, wireType, bytes: buf.subarray(afterLen, afterLen + len) });
      i = afterLen + len;
    } else if (wireType === 5 && i + 4 <= buf.length) {
      i += 4;
    } else if (wireType === 1 && i + 8 <= buf.length) {
      i += 8;
    } else {
      return null;
    }
  }
  return fields.length > 0 ? fields : null;
}

/** A lone `file://…` URI — per-tool results echo their target this way. */
function isBareUri(text: string): boolean {
  return /^file:\/\/\S*$/.test(text);
}

/** Leaf preference: any real text beats a bare URI echo; then longer wins. */
function isBetterLeaf(candidate: string, best: string): boolean {
  if (!candidate) return false;
  if (!best) return true;
  const candidateUri = isBareUri(candidate);
  if (candidateUri !== isBareUri(best)) return !candidateUri;
  return candidate.length > best.length;
}

/**
 * Best text leaf under `buf` (sub-messages recursed), skipping `exclude`: the
 * longest one, except that a bare `file://` URI (view_file / list_dir echo
 * their target) only wins when nothing else is there.
 */
function longestTextLeaf(buf: Buffer, exclude: ReadonlySet<string>, depth = 0): string {
  const fields = depth < 8 ? decodeProtoStrict(buf) : null;
  if (!fields) {
    if (!looksLikeText(buf)) return '';
    const text = buf.toString('utf-8').trim();
    return exclude.has(text) ? '' : text;
  }
  let best = '';
  for (const f of fields) {
    if (f.wireType !== 2 || !f.bytes || f.bytes.length === 0) continue;
    const leaf = longestTextLeaf(f.bytes, exclude, depth + 1);
    if (isBetterLeaf(leaf, best)) best = leaf;
  }
  return best;
}

/**
 * One-line call summary, mirroring claude's `name: args` bubble. run_command's
 * `CommandLine` is preferred (claude prefers `command`); otherwise the args
 * JSON minus antigravity's UI-only hint keys.
 */
export function summarizeAgyToolCallArgs(argsJson: string): { text: string; truncated: boolean } {
  if (!argsJson) return { text: '', truncated: false };
  let parsed: unknown;
  try { parsed = JSON.parse(argsJson); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const args = parsed as Record<string, unknown>;
    const command = args.CommandLine;
    if (typeof command === 'string' && command.trim()) return oneLine(command, TOOL_CALL_SUMMARY_MAX);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (!AGY_UI_ONLY_ARG_KEYS.includes(key)) rest[key] = value;
    }
    if (Object.keys(rest).length === 0) return { text: '', truncated: false };
    return oneLine(JSON.stringify(rest), TOOL_CALL_SUMMARY_MAX);
  }
  return oneLine(argsJson, TOOL_CALL_SUMMARY_MAX);
}

/** Top-level string values of a call's args JSON (trimmed). */
function argStringValues(argsJson: string): string[] {
  try {
    const parsed = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.values(parsed as Record<string, unknown>)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim());
  } catch {
    return [];
  }
}

/** Full call args for the expand path — the WHOLE object, pretty-printed. */
export function fullAgyToolCallArgs(argsJson: string): string {
  try { return JSON.stringify(JSON.parse(argsJson), null, 2) ?? argsJson; } catch { return argsJson; }
}

/**
 * Full result text of an EXECUTION step (null when the row is not one, or
 * carries nothing to show). `status` null = the store has no status column.
 */
export function extractToolStepResult(
  payload: Buffer,
  errorDetails: Buffer | null,
  status: number | null,
): { name: string; text: string } | null {
  const header = firstLenField(payload, 5);
  const call = decodeToolCall(header ? firstLenField(header, 4) : null);
  if (!call) return null;

  const errorText = (
    textField(errorDetails, 1)
    ?? textField(errorDetails, 2)
    ?? textField(firstLenField(payload, 31), 1)
    ?? ''
  ).trim();

  let output = '';
  const generic = firstLenField(payload, 140);
  if (generic) {
    output = (textField(firstLenField(generic, 2), 1) ?? '').trim();
  } else {
    // A leaf equal to the call's own name/args (or one arg value — e.g. a
    // zero-hit find_by_name whose only text leaf is its SearchDirectory) is an
    // echo of the input, not output.
    const exclude = new Set<string>([call.argsJson, call.name, ...argStringValues(call.argsJson)].filter(Boolean));
    for (const f of decodeProtoFields(payload)) {
      if (f.wireType !== 2 || !f.bytes || AGY_TOOL_STEP_NON_OUTPUT_FIELDS.has(f.field)) continue;
      const leaf = longestTextLeaf(f.bytes, exclude);
      if (isBetterLeaf(leaf, output)) output = leaf;
    }
  }

  const failed = status !== null && status !== AGY_STATUS_DONE;
  if (errorText && (failed || !output)) {
    // Keep real output (a failed command's stderr) but not a target-URI echo.
    const detail = output && !isBareUri(output) ? `\n${output}` : '';
    return { name: call.name, text: `Error: ${errorText}${detail}` };
  }
  return output ? { name: call.name, text: output } : null;
}

/** Full text of a step_type 101 task notification (null when absent). */
export function extractTaskNotification(payload: Buffer): { name: string; text: string } | null {
  const note = firstLenField(payload, 114);
  if (!note) return null;
  const name = textField(note, 3)?.trim() || 'task_notification';
  const body = firstLenField(note, 2);
  const title = (textField(body, 1) ?? '').trim();
  const detail = body ? longestTextLeaf(body, new Set(title ? [title] : [])) : '';
  const text = [title, detail].filter(Boolean).join('\n') || (textField(note, 1) ?? '').trim();
  return text ? { name, text } : null;
}

/** Does this execution-step status carry a settled result worth showing? */
export function isSettledToolStatus(status: number | null, errorDetails: Buffer | null): boolean {
  if (status === null) return true; // no status column (legacy/synthetic store)
  if (AGY_TOOL_SETTLED_STATUSES.has(status)) return true;
  return status === AGY_STATUS_DENIED && !!errorDetails && errorDetails.length > 0;
}

/**
 * Strip USER_REQUEST XML wrapper from antigravity user prompts.
 * Antigravity wraps structured user input in <USER_REQUEST>...</USER_REQUEST>.
 */
export function extractUserRequestContent(content: string): string {
  const raw = content.trim();
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match) return match[1].trim();
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
}
