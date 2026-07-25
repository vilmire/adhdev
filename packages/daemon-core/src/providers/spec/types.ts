/**
 * Shared types for the adhdev:cli/spec@4 FSM spec system.
 *
 * These are the building blocks reused by fsm-types.ts, evaluator.ts, and
 * the rest of the spec stack. v3/v1 types have been removed — all providers
 * are on v4.
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Shared / layout types
// ─────────────────────────────────────────────────────────────────────────────

export type Size = number | string;

export interface SectionPattern {
    section?: string;
    pattern: string;
    flags?: string;
}

/** Inline wait_for shape used by open_picker control actions. */
export interface WaitForCondition {
    section?: string;
    regex?: string;
    flags?: string;
}

export type ControlAction =
    | { type: 'send_keys'; keys: string }
    | {
          type: 'open_picker';
          trigger_keys: string;
          wait_for: WaitForCondition;
          extract_choices: SectionPattern;
          submit_key: string;
          /**
           * How a parsed choice is committed once the picker is open.
           *   'index' (default) — type the on-screen number then `submit_key`
           *     (`{index}\r`). Correct for CLIs whose picker is number-selectable
           *     (codex-cli, hermes-cli).
           *   'arrow_keys' — the picker is a cursor list that ignores number keys
           *     (claude-cli /model): move the cursor from its current row to the
           *     target row with up/down arrows, then confirm with the `submit_key`
           *     tail (the `\r` left after stripping `{index}`). Requires the
           *     extracted choices to flag the current cursor row.
           */
          select_mode?: 'index' | 'arrow_keys';
          /** Arrow byte sequences for `select_mode: 'arrow_keys'`. Defaults to
           *  ANSI cursor up/down (`[A` / `[B`) when omitted. */
          cursor_keys?: { up: string; down: string };
      }
    | {
          type: 'attach_image';
          method: 'tempfile_then_keys';
          keys_template: string;
      };

export interface Control {
    id: string;
    label: string;
    visible_when_state?: string[];
    action: ControlAction;
}

export interface NotificationRule {
    id: string;
    when_state: string;
    title: string;
    body?: string;
}

export interface DelegateTrigger {
    id: string;
    when_state: string;
    after_duration_ms?: number;
    task_template: string;
}

export interface NativeHistoryConfig {
    reader?: 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'hermes-cli';
    source?: NativeHistorySource;
    override_path?: string;
}

export type NativeHistorySource =
    | NativeHistoryJsonlSource
    | NativeHistorySqliteSource;

export interface NativeHistoryJsonlSource {
    kind: 'jsonl';
    path: string;
    file_pattern?: string;
    recent_window_ms?: number;
    /**
     * Where to read the provider session id from.
     *   'filename_uuid' (default) — the transcript FILE basename embeds the
     *     uuid (`<uuid>.jsonl`, cursor-agent).
     *   'first_record'  — jsonpath (`session_id_path`) into the first record.
     *   'dir_uuid'      — a PARENT DIRECTORY segment embeds the uuid, and the
     *     leaf file has a fixed name. kimi persists every session at
     *     `~/.kimi-code/sessions/<wdKey>/session_<uuid>/agents/main/wire.jsonl`
     *     — the file is always `wire.jsonl`, so the uuid can only come from the
     *     `session_<uuid>` directory segment. The nearest ancestor segment
     *     containing a uuid wins.
     */
    session_id_from?: 'filename_uuid' | 'first_record' | 'dir_uuid';
    session_id_path?: string;
    /**
     * Fallback workspace attribution from a per-session SIDECAR json file when
     * the transcript itself carries no `session_meta` cwd record AND the on-disk
     * directory slug is irreversible. kimi's `wire.jsonl` has no cwd line and the
     * `wd_<slug>_<sha12>` directory segment is a lossy slug + hash that cannot be
     * reversed to the real workspace. But kimi writes a sibling `state.json` next
     * to the session dir carrying the authoritative `workDir`. This option names
     * that sidecar (relative to the resolved wire file's directory) and the json
     * path to the workspace inside it; the executor reads it, stamps the value as
     * the transcript workspace on every message, and — for workspace-scoped file
     * selection (no pinned session id yet, the antigravity/opencode first-read
     * case) — only accepts a candidate wire file whose sidecar workDir matches the
     * input workspace. Mirrors cursor's `workspace_from_input` and opencode's
     * per-row `message_map.workspace`, for a jsonl store whose workspace lives in
     * a sidecar rather than in the transcript or a reversible slug.
     */
    workspace_from_sidecar?: {
        /** Path to the sidecar json, relative to the resolved wire file's
         *  directory. e.g. `../../state.json` for
         *  `session_<uuid>/agents/main/wire.jsonl` → `session_<uuid>/state.json`. */
        rel_path: string;
        /** jsonpath-lite to the workspace string inside the sidecar. e.g.
         *  `$.workDir`. */
        workspace_path: string;
    };
    /**
     * Multi-shape record projection. A jsonl store whose user turns and
     * assistant turns are DIFFERENT record types (so a single `message_map`
     * can't extract both roles) declares one matcher per shape here. For each
     * on-disk record the executor picks the FIRST entry whose `where` matches
     * and projects the record with that entry's `message_map`; a record that
     * matches no entry is dropped. kimi stores user turns as
     * `type=="turn.prompt"` (`$.input[*].text`, role=user) and assistant text as
     * `type=="context.append_loop_event"` content.part events
     * (`$.event.part.text`, role=assistant) — two shapes with different role and
     * content paths. Absent → the top-level single `message_map` (+ optional
     * `message_filter`) path is used unchanged.
     */
    records?: Array<{ where?: string; message_map: NativeHistoryMessageMap }>;
    message_filter?: { where: string };
    /**
     * Fallback workspace attribution when the transcript carries no
     * `session_meta` cwd record. Some stores (cursor-agent) do NOT write a
     * session_meta line and keep the workspace only in the on-disk project-slug
     * directory (`~/.cursor/projects/<slug>/…`), which is a lossy, sometimes
     * truncated+hashed transform of the real path and cannot be reversed. When
     * this flag is set and no session_meta workspace was found, the executor
     * stamps `input.workspace` onto each message — but ONLY after confirming the
     * resolved file actually lives under that workspace's project slug (a path
     * segment matches the input workspace's cursor/claude slug, allowing for
     * cursor's length-truncation). This closes the first-turn read gap (before a
     * provider session id is pinned, the downstream hasSafeNativeHistoryMapping
     * guard needs a per-message workspace) without risking cross-workspace
     * aliasing: a slug mismatch leaves the workspace unset and the read fails
     * closed as before.
     */
    workspace_from_input?: boolean;
    /** Single-shape projection. Required unless `records` (multi-shape) is set. */
    message_map?: NativeHistoryMessageMap;
}

export interface NativeHistorySqliteSource {
    kind: 'sqlite';
    path: string;
    session_query: string;
    message_query: string;
    /**
     * Optional sub-session cluster expansion. Some agents (hermes ≥0.14) split
     * a SINGLE logical turn across several `sessions` rows linked by a parent
     * pointer, and the turn's final assistant message lands in a DIFFERENT row
     * than the one `session_query` / the daemon's pin resolves. Reading only
     * the anchor session then surfaces zero (or stale) assistant bubbles even
     * though the answer is physically present in a sibling/descendant row —
     * `read_chat` returns no final assistant and the completion gate false-fires
     * `missing_final_assistant`.
     *
     * When present, the executor treats the resolved session id as an ANCHOR
     * and runs this query (bound `?` = anchor id) to expand it to every session
     * id in the same logical cluster (typically a `WITH RECURSIVE` walk over the
     * parent pointer, up to the root and back down through all descendants).
     * `message_query` is then run once per cluster id and the rows merged and
     * re-sorted by their mapped timestamp, so the turn's final assistant — in
     * whichever sub-session it was written — is always included. Each returned
     * row's first column is a cluster session id.
     *
     * Absent → single-session behaviour is unchanged (anchor session only).
     */
    session_cluster_query?: string;
    message_map: NativeHistoryMessageMap;
}

export interface NativeHistoryMessageMap {
    role: string;
    content: string;
    content_strip?: string[];
    content_unwrap?: string[];
    timestamp_ms?: string;
    kind?: string;
    /**
     * Optional jsonpath-lite path to a per-message workspace/cwd value. sqlite
     * sources have no `session_meta` record to carry the workspace (that's a
     * jsonl-only convention), so a native-source provider whose store keeps the
     * session directory as a column (e.g. opencode's `session.directory`) can
     * SELECT it into each message row and map it here. The read pipeline's
     * `hasSafeNativeHistoryMapping` guard requires each message to declare a
     * workspace when the read is workspace-scoped (no provider session id was
     * captured from the TUI); without it a workspace-only lookup fails closed
     * and every assistant bubble is dropped. Absent → messages carry no
     * workspace (jsonl still fills it from session_meta).
     */
    workspace?: string;
    /**
     * Declarative tool-bubble extraction. Without it the executor only emits
     * the text-bearing parts of each record, so a turn that is purely a tool
     * call or tool result (no prose) is dropped — the restored transcript
     * loses every tool interaction. When present, the executor walks each
     * record's content blocks and emits an extra `kind:'tool'` message for
     * any block whose `$.type` matches a tool shape.
     *
     * Defaults target the Anthropic-style content-block shape that claude-cli
     * and codex-cli persist (blocks of `{ type: 'tool_use' | 'tool_result',
     * name, input, content }`); a provider with a different on-disk shape
     * overrides the field paths. Set `tools: {}` to opt in with the defaults.
     */
    tools?: NativeHistoryToolMap;
}

/**
 * How to surface tool-call / tool-result blocks as `kind:'tool'` bubbles.
 * Every field is optional — the defaults read the Anthropic block shape.
 * Paths are jsonpath-lite evaluated against a single content block (the
 * element of `$.message.content[]`), not the whole record.
 */
export interface NativeHistoryToolMap {
    /** Path to a block's discriminator. Default `$.type`. */
    block_type?: string;
    /** Block-type values that mean "a tool was invoked". Default
     *  `['tool_use', 'function_call', 'custom_tool_call']`. */
    call_types?: string[];
    /** Block-type values that mean "a tool returned". Default
     *  `['tool_result', 'function_call_output', 'custom_tool_call_output']`. */
    result_types?: string[];
    /** Path to the tool name on a call block. Default `$.name`. */
    call_name?: string;
    /** Path to the tool arguments on a call block. Default `$.input`. */
    call_args?: string;
    /** Path to the result payload on a result block. Default `$.content`. */
    result_content?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section definition
// ─────────────────────────────────────────────────────────────────────────────

export interface AnchorContext {
    prev?: string;
    next?: string;
    prev_flags?: string;
    next_flags?: string;
}

export interface SectionDef {
    from_top?: Size;
    from_bottom?: Size;
    until?: string;             // section id OR regex (starts with ^)
    /**
     * Anchor regex(es). A single string anchors on the first/last matching line
     * (per `anchor_last`). An array is an OR-set of candidate shapes: each
     * candidate resolves its OWN anchor line independently (anchor_last → that
     * candidate's last matching line, else its first), then the TOPMOST resolved
     * line across candidates wins — a section's anchor marks the top of its
     * block, so the highest recognized landmark bounds the whole block. This
     * lets one section capture two shapes — e.g. a box-divider modal AND a
     * divider-less modal whose only stable landmark is the question line above
     * its numbered choices — while preventing a stray LOWER landmark (e.g. an
     * input-box `────` rule below the choices) from clipping the block.
     */
    anchor?: string | string[];
    anchor_flags?: string;
    anchor_last?: boolean;
    /**
     * Context guard(s) for the anchor. A single object applies to every anchor
     * pattern. An array is matched positionally against an `anchor` array (entry
     * i guards anchor i); a positional `undefined`/null entry means "no guard"
     * for that anchor. A scalar `anchor` ignores array form beyond index 0.
     */
    anchor_context?: AnchorContext | (AnchorContext | null)[];
    /**
     * Extends an anchored section N lines ABOVE its anchor line. The default
     * anchored geometry starts the section AT the anchor line, which cannot
     * express a status block that sits directly ABOVE its landmark (e.g.
     * codex's live `Working (…)` spinner above the `› ` composer). With
     * `above: K` the section starts at max(0, anchorLine - K), so the window
     * stays pinned to the landmark regardless of output volume — unlike
     * `from_bottom`, which counts from the LAST NON-BLANK line of a
     * blank-trimmed viewport and lets the live status block escape the window
     * once long output fills the tail (CODEX-FSM-DEGENERATE-STABLE RCA,
     * defect 1: the spinner left the from_bottom:12 window while the worker
     * was still generating).
     */
    above?: number;
    /**
     * Anchor-miss policy. Default (absent): an anchored section whose anchor
     * matches NOTHING falls back to the whole screen (from=0, to=total) — the
     * historical behavior modal sections rely on ("whole-screen fallback in
     * non-modal frames is harmless"). 'empty' resolves the section to EMPTY
     * instead, for sections whose guard regexes must never see unrelated body
     * text: status_tail's spinner cues, whose whole-screen fallback would
     * re-open the SPINNER-BODY-SELFMATCH defect on any frame where the
     * composer landmark is momentarily absent (mid-redraw).
     */
    anchor_miss?: 'empty';
    lines?: number;
    until_regex?: string;
    until_regex_flags?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditions (shared with fsm-types.ts FsmCondition leaves)
// ─────────────────────────────────────────────────────────────────────────────

export interface RegexCondition {
    section?: string;
    matches: string;
    flags?: string;
    cursor_row_min?: number;
    cursor_row_max?: number;
    cursor_col_min?: number;
    cursor_col_max?: number;
}

export interface ChangedCondition {
    cursor_above: number;
    changed: boolean;
    stable_ms?: number;
}

export interface AllCondition {
    all: Condition[];
}

export interface AnyCondition {
    any: Condition[];
}

export type Condition = RegexCondition | ChangedCondition | AllCondition | AnyCondition;

// ─────────────────────────────────────────────────────────────────────────────
// Extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractTitle {
    section?: string;
    regex?: string;
    flags?: string;
    first_line?: true;
}

export interface ExtractButtons {
    section?: string;
    pattern: string;
    flags?: string;
    key_for_index: string;
    min_count?: number;
    continuation_lines?: boolean;
    /**
     * How a button is committed when its modal is resolved (auto-approve or an
     * explicit dashboard click).
     *   'index' (default) — send `key_for_index` with `{index}` filled in
     *     (`{index}\r` → `1\r`). Correct for modals whose buttons are
     *     number-selectable (codex, hermes, antigravity number rows).
     *   'arrow_keys' — the modal is a cursor list that IGNORES number keys
     *     (claude-cli's new TUI approval modal): a typed `1` leaks into the
     *     composer as literal text and `\r` submits it. Instead move the cursor
     *     from its current row to the target row with up/down arrows, then
     *     confirm with the `key_for_index` tail (the `\r` left after stripping
     *     `{index}`). Mirrors the `open_picker` `select_mode` of the same name.
     */
    select_mode?: 'index' | 'arrow_keys';
    /** Arrow byte sequences for `select_mode: 'arrow_keys'`. Defaults to ANSI
     *  cursor up/down (`[A` / `[B`) when omitted. */
    cursor_keys?: { up: string; down: string };
}
