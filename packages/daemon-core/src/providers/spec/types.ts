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

export interface NativeHistoryConfig {
    reader: 'claude-cli' | 'codex-cli' | 'antigravity-cli' | 'hermes-cli';
}

export interface CliSpec {
    $schema: 'adhdev:cli/spec@1';
    id: string;
    name: string;
    binary: string;
    spawn_args?: string[];
    env?: Record<string, string>;
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
}
