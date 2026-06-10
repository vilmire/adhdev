/**
 * Type mirror of adhdev:cli/spec@1 (v1) and adhdev:cli/spec@3 (v3).
 * Keep in sync with schema.gen.ts.
 *
 * v1 uses layout.sections[] and debounce{}.
 * v3 uses sections{} (object) and timing{}, with composable conditions.
 *
 * The loader auto-migrates v1 → v3. Callers receive a CliSpec (v3) after
 * loadSpec; the v1 raw shape is only used during migration.
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Shared / unchanged types
// ─────────────────────────────────────────────────────────────────────────────

export type Size = number | string;

export interface SectionPattern {
    section?: string;
    pattern: string;
    flags?: string;
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
 *
 *   2. `source`: declarative source descriptor.
 *
 *   3. `override_path`: relative path to a provider-supplied reader module.
 */
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
    session_id_from?: 'filename_uuid' | 'first_record';
    session_id_path?: string;
    message_filter?: { where: string };
    message_map: NativeHistoryMessageMap;
}

export interface NativeHistorySqliteSource {
    kind: 'sqlite';
    path: string;
    session_query: string;
    message_query: string;
    message_map: NativeHistoryMessageMap;
}

export interface NativeHistoryMessageMap {
    role: string;
    content: string;
    content_strip?: string[];
    content_unwrap?: string[];
    timestamp_ms?: string;
    kind?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// v1 types (legacy — used internally during migration)
// ─────────────────────────────────────────────────────────────────────────────

export interface Section {
    id: string;
    from_top?: Size;
    from_bottom?: Size;
    until?: { section: string };
    anchor_regex?: string;
    anchor_flags?: string;
    anchor_last?: boolean;
    anchor_context?: {
        prev?: string;
        prev_flags?: string;
        next?: string;
        next_flags?: string;
    };
    lines?: number;
    until_regex?: string;
    until_regex_flags?: string;
}

/** v1 condition — flat SectionRegex object. Also used in control_bar.wait_for. */
export interface SectionRegex {
    section?: string;
    regex?: string;
    flags?: string;
    cursor_row_min?: number;
    cursor_row_max?: number;
    cursor_col_min?: number;
    cursor_col_max?: number;
    /** v1 delta detection (cursor_above_lines + changed). */
    cursor_above_lines?: number;
    /** Required when cursor_above_lines is set. */
    changed?: true;
}

export interface ModalButtonsRule {
    section?: string;
    pattern?: string;
    flags?: string;
    patterns?: Array<{ pattern: string; flags?: string }>;
    key_for_index: string;
    min_count?: number;
    continuation_lines?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// v3 types (current)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v3 section definition — keyed by id in `sections{}` object.
 * `until` is EITHER a section-id string (no `^` prefix) OR a regex string (starts with `^`).
 */
export interface SectionDef {
    // positional
    from_top?: Size;
    from_bottom?: Size;
    until?: string;             // section id OR regex (starts with ^)
    // anchor-based
    anchor?: string;            // regex (replaces anchor_regex)
    anchor_flags?: string;
    anchor_last?: boolean;
    anchor_context?: {
        prev?: string;
        next?: string;
        prev_flags?: string;
        next_flags?: string;
    };
    lines?: number;
    until_regex?: string;       // kept for anchor-based extension
    until_regex_flags?: string;
}

/** v3 regex condition against a section (or full screen). */
export interface RegexCondition {
    section?: string;
    matches: string;            // regex string
    flags?: string;
    cursor_row_min?: number;
    cursor_row_max?: number;
    cursor_col_min?: number;
    cursor_col_max?: number;
}

/** v3 delta condition: N lines above cursor changed vs prevLines. */
export interface ChangedCondition {
    cursor_above: number;
    changed: true;
}

/** v3 AND composite. */
export interface AllCondition {
    all: Condition[];
}

/** v3 OR composite. */
export interface AnyCondition {
    any: Condition[];
}

export type Condition = RegexCondition | ChangedCondition | AllCondition | AnyCondition;

/** v3 extract_title config. */
export interface ExtractTitle {
    section?: string;
    regex?: string;
    flags?: string;
    first_line?: true;
}

/** v3 extract_buttons config. */
export interface ExtractButtons {
    section?: string;
    pattern: string;
    flags?: string;
    key_for_index: string;
    min_count?: number;
    continuation_lines?: boolean;
}

/** v3 state. */
export interface SpecStateV3 {
    id: string;
    label: string;
    when: AllCondition | AnyCondition;
    extract?: {
        title?: ExtractTitle;
        buttons?: ExtractButtons;
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CliSpec — v3 (the canonical runtime type after loading)
// ─────────────────────────────────────────────────────────────────────────────

export interface CliSpec {
    $schema: 'adhdev:cli/spec@3';
    id: string;
    name: string;
    binary: string;
    spawn_args?: string[];
    env?: Record<string, string>;
    cli_version_range?: string;
    send_message: {
        submit_key: string;
        delay_ms_before_submit?: number;
        delay_ms_per_char?: number;
    };
    sections: Record<string, SectionDef>;
    states: SpecStateV3[];
    default_state: string;
    control_bar?: Control[];
    notifications?: NotificationRule[];
    delegate?: DelegateTrigger[];
    native_history?: NativeHistoryConfig;
    requiresFinalAssistantBeforeIdle?: boolean;
    /**
     * Per-spec timing knobs. Replaces v1 `debounce`.
     * Also accessible via the legacy `debounce` alias in the driver for
     * backward compat with older callers.
     */
    timing?: {
        busy_hold_ms?: number;
        idle_hold_ms?: number;
        startup_grace_ms?: number;
        completion_marker?: {
            section?: string;
            matches: string;
            flags?: string;
            hold_ms: number;
            force_after_ms?: number;
        };
    };
    /**
     * Legacy alias: v1 callers (tests, tooling) may read `debounce`.
     * The loader populates both `timing` and `debounce` pointing at the
     * same object so callers that use either field see consistent values.
     * @deprecated Use `timing` instead.
     */
    debounce?: {
        busy_hold_ms?: number;
        idle_hold_ms?: number;
        startup_grace_ms?: number;
        /**
         * Legacy field name for completion_marker. Populated by the loader
         * from `timing.completion_marker` for backward compat.
         */
        completion_idle_after?: {
            section?: string;
            regex: string;
            flags?: string;
            hold_ms: number;
            force_after_ms?: number;
        };
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// v1 CliSpec raw shape (for migration only — not exported as the primary type)
// ─────────────────────────────────────────────────────────────────────────────

/** Raw v1 spec shape as loaded from JSON. Used only in migrateV1toV3. */
export interface RawCliSpecV1 {
    $schema: 'adhdev:cli/spec@1';
    id: string;
    name: string;
    binary: string;
    spawn_args?: string[];
    env?: Record<string, string>;
    cli_version_range?: string;
    send_message: {
        submit_key: string;
        delay_ms_before_submit?: number;
        delay_ms_per_char?: number;
    };
    layout: { sections: Section[] };
    states: Array<{
        id: string;
        label: string;
        when: SectionRegex;
        extract_title?: SectionRegex;
        modal_buttons?: ModalButtonsRule;
    }>;
    default_state: string;
    control_bar?: Control[];
    notifications?: NotificationRule[];
    delegate?: DelegateTrigger[];
    native_history?: NativeHistoryConfig;
    requiresFinalAssistantBeforeIdle?: boolean;
    debounce?: {
        busy_hold_ms?: number;
        idle_hold_ms?: number;
        startup_grace_ms?: number;
        completion_idle_after?: {
            section?: string;
            regex: string;
            flags?: string;
            hold_ms: number;
            force_after_ms?: number;
        };
    };
}

// Keep SpecState as alias for backward compat with cli-adapter.ts and other code
// that imports SpecState from types.ts. In v3 we use SpecStateV3.
export type SpecState = SpecStateV3;
