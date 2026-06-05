/**
 * Type mirror of adhdev:cli/spec@1. Keep in sync with schema.json.
 * Adding a field here without also adding it to schema.json (or vice
 * versa) is a bug — the loader rejects specs that don't match the
 * schema, so a missing field would fail at load time.
 */
'use strict';

export type Size = number | string;

export interface Section {
    id: string;
    from_top?: Size;
    from_bottom?: Size;
    until?: { section: string };
}

export interface SectionRegex {
    section?: string;
    regex: string;
    flags?: string;
}

export interface SectionPattern {
    section?: string;
    pattern: string;
    flags?: string;
}

export interface ModalButtonsRule {
    section?: string;
    pattern: string;
    flags?: string;
    key_for_index: string;
    min_count?: number;
}

export interface SpecState {
    id: string;
    label: string;
    when: SectionRegex;
    extract_title?: SectionRegex;
    modal_buttons?: ModalButtonsRule;
}

export type ControlAction =
    | { type: 'send_keys'; keys: string }
    | {
          type: 'open_picker';
          trigger_keys: string;
          wait_for: SectionRegex;
          extract_choices: SectionPattern;
          submit_key: string;
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

/**
 * Native history config — three modes, picked by which fields are present:
 *
 *   1. `reader`: built-in reader id (claude-cli / codex-cli / antigravity-cli / hermes-cli).
 *      Backwards-compatible path used by the four shipped providers.
 *
 *   2. `source`: declarative source descriptor. The daemon's spec native-history
 *      executor reads the on-disk store (jsonl file / sqlite db) directly using
 *      paths + jsonpath maps from this block. New providers should prefer this
 *      mode — no daemon changes required.
 *
 *   3. `override_path`: relative path to a provider-supplied reader module
 *      (e.g. "./native_history/index.js"). Escape hatch for formats too
 *      exotic for the declarative executor. The module must default-export
 *      a function with the signature
 *        (input: NativeHistoryInput) => NativeHistoryResult | null
 *      and runs under provider-script-root sandboxing (same gate as
 *      scripts.js).
 *
 * The three modes are mutually exclusive — set exactly one. Loader rejects
 * specs that set zero or more than one.
 */
export interface NativeHistoryConfig {
    reader?: 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'hermes-cli';
    source?: NativeHistorySource;
    override_path?: string;
}

export type NativeHistorySource =
    | NativeHistoryJsonlSource
    | NativeHistorySqliteSource;

/**
 * JSONL source — each line in the resolved file is one record.
 *
 * `path` accepts ~/, environment variables (${HOME}), and a small set of
 * runtime variables:
 *   {cwd}              — the session's working directory, raw
 *   {cwd_dashed}       — cwd with `/` replaced by `-` (claude's per-project key)
 *   {session_id}       — providerSessionId, when known
 *   {yyyy} {mm} {dd}   — UTC date components
 *
 * When `path` resolves to a directory, the daemon picks the newest file
 * matching `file_pattern` whose mtime is inside `recent_window_ms` (default
 * 5min) — prevents the wrong session's transcript from leaking through.
 */
export interface NativeHistoryJsonlSource {
    kind: 'jsonl';
    path: string;
    file_pattern?: string;
    recent_window_ms?: number;
    session_id_from?: 'filename_uuid' | 'first_record';
    session_id_path?: string; // jsonpath into the first record when session_id_from='first_record'
    message_filter?: { where: string }; // tiny expression: field op value joined by && / ||
    message_map: NativeHistoryMessageMap;
}

/**
 * SQLite source — provider runs two queries on a read-only handle: one to
 * pick the session row (`session_query` — first row's first column is the
 * sessionId), then one to fetch messages (`message_query` — `?` is bound
 * to the sessionId). Output rows are projected through `message_map`.
 */
export interface NativeHistorySqliteSource {
    kind: 'sqlite';
    path: string;
    session_query: string;
    message_query: string;
    message_map: NativeHistoryMessageMap;
}

/**
 * Maps a source record (jsonl line object / sqlite row) to a daemon
 * native-history message. Values are jsonpath-lite strings: `$.foo.bar`
 * or `$.items[0].text`. Literal strings (no leading `$`) pass through.
 *
 * `content_strip` lets a spec drop wrapper tags that the agent injects
 * into its own transcript (claude's `<local-command-caveat>`, agy's
 * `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>`).
 * Each entry is a tag name; the executor removes `<tag>…</tag>` segments
 * non-greedily before the value is handed to the dashboard. After all
 * strips, leading/trailing whitespace is trimmed. If the result is empty
 * the message is dropped.
 */
export interface NativeHistoryMessageMap {
    role: string;            // → 'user' | 'assistant' | 'system' after normalize
    content: string;
    /**
     * Tags whose entire `<tag>…</tag>` segment is removed from content.
     * Use for noise wrappers the agent ships alongside the real message
     * (claude's `<local-command-caveat>`, agy's `<ADDITIONAL_METADATA>`).
     */
    content_strip?: string[];
    /**
     * Tags whose open/close markers are removed but inner content is kept.
     * Use when the *real* user/assistant message is wrapped in a tag
     * the agent uses for routing (agy wraps user input in `<USER_REQUEST>`).
     */
    content_unwrap?: string[];
    timestamp_ms?: string;   // optional; falls back to receivedAt = now
    kind?: string;           // optional; defaults to 'standard'
}

export interface CliSpec {
    $schema: 'adhdev:cli/spec@1';
    id: string;
    name: string;
    binary: string;
    spawn_args?: string[];
    env?: Record<string, string>;
    /**
     * Optional version constraint this spec is authored for, e.g. ">=2.1.0".
     * Pure metadata used by tooling/UI — the actual version-to-spec match
     * happens in provider-loader via the manifest's compatibility array.
     * Spec authors include this so a misrouted spec is easy to spot.
     */
    cli_version_range?: string;
    send_message: {
        submit_key: string;
        delay_ms_before_submit?: number;
        delay_ms_per_char?: number;
    };
    layout: { sections: Section[] };
    states: SpecState[];
    default_state: string;
    control_bar?: Control[];
    notifications?: NotificationRule[];
    delegate?: DelegateTrigger[];
    native_history?: NativeHistoryConfig;
    /**
     * Per-spec debounce knobs. Defaults are conservative (busy_hold_ms
     * 6000) and live in SpecDriver. Spec authors override here when a
     * particular CLI flickers slower/faster than the default.
     */
    debounce?: {
        /** Min time to stay in busy after the evaluator last reported it.
         *  Absorbs per-frame flicker in TUIs that stream output through
         *  the same region as the spinner. */
        busy_hold_ms?: number;
        /** Min time after start() before a send_message is allowed to
         *  reach the PTY. Banner paints + auth flows + skill listings
         *  can keep the agent unable to accept input for several seconds
         *  even though the idle regex matches a transient empty prompt.
         *  Send_messages issued before this window are queued and drained
         *  once the window passes and an idle state has actually been
         *  observed. */
        startup_grace_ms?: number;
    };
}
