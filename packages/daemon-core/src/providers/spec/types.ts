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
// Section definition
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionDef {
    from_top?: Size;
    from_bottom?: Size;
    until?: string;             // section id OR regex (starts with ^)
    anchor?: string;
    anchor_flags?: string;
    anchor_last?: boolean;
    anchor_context?: {
        prev?: string;
        next?: string;
        prev_flags?: string;
        next_flags?: string;
    };
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
}
