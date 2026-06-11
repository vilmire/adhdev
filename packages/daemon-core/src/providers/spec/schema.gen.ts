/**
 * Auto-generated. Mirrors schema.json — regenerate after editing.
 *
 * SCHEMA_V1: validates adhdev:cli/spec@1 (legacy). Used for migration.
 * SCHEMA_V3: validates adhdev:cli/spec@3 (current). Used after migration.
 * SCHEMA: alias for SCHEMA_V3 (default export for loader.ts).
 */

export const SCHEMA_V1 = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "adhdev:cli/spec@1",
    "title": "ADHDev CLI provider spec v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
        "$schema",
        "id",
        "name",
        "binary",
        "send_message",
        "layout",
        "states",
        "default_state"
    ],
    "properties": {
        "$schema": {
            "type": "string",
            "const": "adhdev:cli/spec@1"
        },
        "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9-]*$" },
        "name": { "type": "string", "minLength": 1 },
        "binary": { "type": "string", "minLength": 1 },
        "spawn_args": { "type": "array", "items": { "type": "string" }, "default": [] },
        "env": { "type": "object", "additionalProperties": { "type": "string" }, "default": {} },
        "send_message": {
            "type": "object",
            "additionalProperties": false,
            "required": ["submit_key"],
            "properties": {
                "submit_key": { "type": "string", "minLength": 1 },
                "delay_ms_before_submit": { "type": "integer", "minimum": 0 },
                "delay_ms_per_char": { "type": "integer", "minimum": 0 }
            }
        },
        "layout": {
            "type": "object",
            "additionalProperties": false,
            "required": ["sections"],
            "properties": {
                "sections": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "$ref": "#/definitions/sectionV1" }
                }
            }
        },
        "states": {
            "type": "array",
            "minItems": 1,
            "items": { "$ref": "#/definitions/stateV1" }
        },
        "default_state": { "type": "string", "minLength": 1 },
        "control_bar": { "type": "array", "default": [], "items": { "$ref": "#/definitions/control" } },
        "notifications": { "type": "array", "default": [], "items": { "$ref": "#/definitions/notification" } },
        "delegate": { "type": "array", "default": [], "items": { "$ref": "#/definitions/delegateTrigger" } },
        "native_history": { "$ref": "#/definitions/nativeHistory" },
        "cli_version_range": { "type": "string", "minLength": 1 },
        "requiresFinalAssistantBeforeIdle": { "type": "boolean" },
        "debounce": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "busy_hold_ms": { "type": "integer", "minimum": 0 },
                "idle_hold_ms": { "type": "integer", "minimum": 0 },
                "startup_grace_ms": { "type": "integer", "minimum": 0 },
                "completion_idle_after": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["regex", "hold_ms"],
                    "properties": {
                        "section": { "type": "string", "minLength": 1 },
                        "regex": { "type": "string", "minLength": 1 },
                        "flags": { "type": "string" },
                        "hold_ms": { "type": "integer", "minimum": 0 },
                        "force_after_ms": { "type": "integer", "minimum": 0 }
                    }
                }
            }
        }
    },
    "definitions": {
        "size": {
            "oneOf": [
                { "type": "integer", "minimum": 0 },
                { "type": "string", "pattern": "^\\d+(\\.\\d+)?%$" }
            ]
        },
        "sectionV1": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "from_top": { "$ref": "#/definitions/size" },
                "from_bottom": { "$ref": "#/definitions/size" },
                "until": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["section"],
                    "properties": { "section": { "type": "string" } }
                },
                "anchor_regex": { "type": "string", "minLength": 1 },
                "anchor_flags": { "type": "string" },
                "anchor_last": { "type": "boolean" },
                "anchor_context": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "prev": { "type": "string" },
                        "prev_flags": { "type": "string" },
                        "next": { "type": "string" },
                        "next_flags": { "type": "string" }
                    }
                },
                "lines": { "type": "integer", "minimum": 1 },
                "until_regex": { "type": "string", "minLength": 1 },
                "until_regex_flags": { "type": "string" }
            }
        },
        "sectionRegex": {
            "type": "object",
            "additionalProperties": false,
            "required": ["regex"],
            "properties": {
                "section": { "type": "string" },
                "regex": { "type": "string", "minLength": 1 },
                "flags": { "type": "string", "default": "i" },
                "cursor_row_min": { "type": "integer", "minimum": 0 },
                "cursor_row_max": { "type": "integer", "minimum": 0 },
                "cursor_col_min": { "type": "integer", "minimum": 0 },
                "cursor_col_max": { "type": "integer", "minimum": 0 },
                "cursor_above_lines": { "type": "integer", "minimum": 1 },
                "changed": { "type": "boolean", "const": true }
            }
        },
        "sectionPattern": {
            "type": "object",
            "additionalProperties": false,
            "required": ["pattern"],
            "properties": {
                "section": { "type": "string" },
                "pattern": { "type": "string", "minLength": 1 },
                "flags": { "type": "string", "default": "" }
            }
        },
        "stateV1": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "label", "when"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "label": { "type": "string", "minLength": 1 },
                "when": { "$ref": "#/definitions/sectionRegex" },
                "extract_title": { "$ref": "#/definitions/sectionRegex" },
                "modal_buttons": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["key_for_index"],
                    "oneOf": [
                        { "required": ["pattern"] },
                        { "required": ["patterns"] }
                    ],
                    "properties": {
                        "section": { "type": "string" },
                        "pattern": { "type": "string", "minLength": 1 },
                        "flags": { "type": "string" },
                        "patterns": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["pattern"],
                                "properties": {
                                    "pattern": { "type": "string", "minLength": 1 },
                                    "flags": { "type": "string" }
                                }
                            }
                        },
                        "key_for_index": { "type": "string", "minLength": 1 },
                        "min_count": { "type": "integer", "minimum": 1, "default": 2 },
                        "continuation_lines": { "type": "boolean", "default": false }
                    }
                }
            }
        },
        "control": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "label", "action"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "label": { "type": "string", "minLength": 1 },
                "visible_when_state": { "type": "array", "items": { "type": "string" } },
                "action": { "$ref": "#/definitions/controlAction" }
            }
        },
        "controlAction": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "keys"],
                    "properties": {
                        "type": { "const": "send_keys" },
                        "keys": { "type": "string", "minLength": 1 }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "trigger_keys", "wait_for", "extract_choices", "submit_key"],
                    "properties": {
                        "type": { "const": "open_picker" },
                        "trigger_keys": { "type": "string", "minLength": 1 },
                        "wait_for": { "$ref": "#/definitions/sectionRegex" },
                        "extract_choices": { "$ref": "#/definitions/sectionPattern" },
                        "submit_key": { "type": "string", "minLength": 1 }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "method", "keys_template"],
                    "properties": {
                        "type": { "const": "attach_image" },
                        "method": { "const": "tempfile_then_keys" },
                        "keys_template": { "type": "string", "minLength": 1 }
                    }
                }
            ]
        },
        "notification": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "when_state", "title"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "when_state": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1 },
                "body": { "type": "string" }
            }
        },
        "nativeHistory": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "reader": {
                    "type": "string",
                    "enum": ["claude-cli", "codex-cli", "antigravity-cli", "hermes-cli"]
                },
                "source": {
                    "oneOf": [
                        { "$ref": "#/definitions/nativeHistoryJsonlSource" },
                        { "$ref": "#/definitions/nativeHistorySqliteSource" }
                    ]
                },
                "override_path": { "type": "string", "minLength": 1 }
            }
        },
        "nativeHistoryMessageMap": {
            "type": "object",
            "additionalProperties": false,
            "required": ["role", "content"],
            "properties": {
                "role": { "type": "string", "minLength": 1 },
                "content": { "type": "string", "minLength": 1 },
                "content_strip": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "content_unwrap": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "timestamp_ms": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "minLength": 1 }
            }
        },
        "nativeHistoryJsonlSource": {
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "path", "message_map"],
            "properties": {
                "kind": { "const": "jsonl" },
                "path": { "type": "string", "minLength": 1 },
                "file_pattern": { "type": "string", "minLength": 1 },
                "recent_window_ms": { "type": "integer", "minimum": 0 },
                "session_id_from": { "type": "string", "enum": ["filename_uuid", "first_record"] },
                "session_id_path": { "type": "string", "minLength": 1 },
                "message_filter": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["where"],
                    "properties": { "where": { "type": "string", "minLength": 1 } }
                },
                "message_map": { "$ref": "#/definitions/nativeHistoryMessageMap" }
            }
        },
        "nativeHistorySqliteSource": {
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "path", "session_query", "message_query", "message_map"],
            "properties": {
                "kind": { "const": "sqlite" },
                "path": { "type": "string", "minLength": 1 },
                "session_query": { "type": "string", "minLength": 1 },
                "message_query": { "type": "string", "minLength": 1 },
                "message_map": { "$ref": "#/definitions/nativeHistoryMessageMap" }
            }
        },
        "delegateTrigger": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "when_state", "task_template"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "when_state": { "type": "string", "minLength": 1 },
                "after_duration_ms": { "type": "integer", "minimum": 0 },
                "task_template": { "type": "string", "minLength": 1 }
            }
        }
    }
} as const;

export const SCHEMA_V3 = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "adhdev:cli/spec@3",
    "title": "ADHDev CLI provider spec v3",
    "type": "object",
    "additionalProperties": false,
    "required": [
        "$schema",
        "id",
        "name",
        "binary",
        "send_message",
        "sections",
        "states",
        "default_state"
    ],
    "properties": {
        "$schema": { "type": "string", "const": "adhdev:cli/spec@3" },
        "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9-]*$" },
        "name": { "type": "string", "minLength": 1 },
        "binary": { "type": "string", "minLength": 1 },
        "spawn_args": { "type": "array", "items": { "type": "string" }, "default": [] },
        "env": { "type": "object", "additionalProperties": { "type": "string" }, "default": {} },
        "cli_version_range": { "type": "string", "minLength": 1 },
        "send_message": {
            "type": "object",
            "additionalProperties": false,
            "required": ["submit_key"],
            "properties": {
                "submit_key": { "type": "string", "minLength": 1 },
                "delay_ms_before_submit": { "type": "integer", "minimum": 0 },
                "delay_ms_per_char": { "type": "integer", "minimum": 0 }
            }
        },
        "sections": {
            "type": "object",
            "minProperties": 1,
            "additionalProperties": { "$ref": "#/definitions/sectionDef" }
        },
        "states": {
            "type": "array",
            "minItems": 1,
            "items": { "$ref": "#/definitions/stateV3" }
        },
        "default_state": { "type": "string", "minLength": 1 },
        "control_bar": { "type": "array", "default": [], "items": { "$ref": "#/definitions/control" } },
        "notifications": { "type": "array", "default": [], "items": { "$ref": "#/definitions/notification" } },
        "delegate": { "type": "array", "default": [], "items": { "$ref": "#/definitions/delegateTrigger" } },
        "native_history": { "$ref": "#/definitions/nativeHistory" },
        "requiresFinalAssistantBeforeIdle": { "type": "boolean" },
        "timing": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "busy_hold_ms": { "type": "integer", "minimum": 0 },
                "idle_hold_ms": { "type": "integer", "minimum": 0 },
                "startup_grace_ms": { "type": "integer", "minimum": 0 },
                "screen_active_hold_ms": { "type": "integer", "minimum": 0 },
                "completion_marker": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["matches", "hold_ms"],
                    "properties": {
                        "section": { "type": "string", "minLength": 1 },
                        "matches": { "type": "string", "minLength": 1 },
                        "flags": { "type": "string" },
                        "hold_ms": { "type": "integer", "minimum": 0 },
                        "force_after_ms": { "type": "integer", "minimum": 0 }
                    }
                }
            }
        }
    },
    "definitions": {
        "size": {
            "oneOf": [
                { "type": "integer", "minimum": 0 },
                { "type": "string", "pattern": "^\\d+(\\.\\d+)?%$" }
            ]
        },
        "sectionDef": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "from_top": { "$ref": "#/definitions/size" },
                "from_bottom": { "$ref": "#/definitions/size" },
                "until": { "type": "string", "minLength": 1 },
                "anchor": { "type": "string", "minLength": 1 },
                "anchor_flags": { "type": "string" },
                "anchor_last": { "type": "boolean" },
                "anchor_context": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "prev": { "type": "string" },
                        "prev_flags": { "type": "string" },
                        "next": { "type": "string" },
                        "next_flags": { "type": "string" }
                    }
                },
                "lines": { "type": "integer", "minimum": 1 },
                "until_regex": { "type": "string", "minLength": 1 },
                "until_regex_flags": { "type": "string" }
            }
        },
        "condition": {
            "oneOf": [
                { "$ref": "#/definitions/regexCondition" },
                { "$ref": "#/definitions/changedCondition" },
                { "$ref": "#/definitions/allCondition" },
                { "$ref": "#/definitions/anyCondition" }
            ]
        },
        "regexCondition": {
            "type": "object",
            "additionalProperties": false,
            "required": ["matches"],
            "properties": {
                "section": { "type": "string" },
                "matches": { "type": "string", "minLength": 1 },
                "flags": { "type": "string" },
                "cursor_row_min": { "type": "integer", "minimum": 0 },
                "cursor_row_max": { "type": "integer", "minimum": 0 },
                "cursor_col_min": { "type": "integer", "minimum": 0 },
                "cursor_col_max": { "type": "integer", "minimum": 0 }
            }
        },
        "changedCondition": {
            "type": "object",
            "additionalProperties": false,
            "required": ["cursor_above", "changed"],
            "properties": {
                "cursor_above": { "type": "integer", "minimum": 1 },
                "changed": { "type": "boolean" },
                "stable_ms": { "type": "integer", "minimum": 0 }
            }
        },
        "allCondition": {
            "type": "object",
            "additionalProperties": false,
            "required": ["all"],
            "properties": {
                "all": {
                    "type": "array",
                    "items": { "$ref": "#/definitions/condition" }
                }
            }
        },
        "anyCondition": {
            "type": "object",
            "additionalProperties": false,
            "required": ["any"],
            "properties": {
                "any": {
                    "type": "array",
                    "items": { "$ref": "#/definitions/condition" }
                }
            }
        },
        "extractTitle": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "section": { "type": "string" },
                "regex": { "type": "string", "minLength": 1 },
                "flags": { "type": "string" },
                "first_line": { "type": "boolean", "const": true }
            }
        },
        "extractButtons": {
            "type": "object",
            "additionalProperties": false,
            "required": ["pattern", "key_for_index"],
            "properties": {
                "section": { "type": "string" },
                "pattern": { "type": "string", "minLength": 1 },
                "flags": { "type": "string" },
                "key_for_index": { "type": "string", "minLength": 1 },
                "min_count": { "type": "integer", "minimum": 1, "default": 2 },
                "continuation_lines": { "type": "boolean", "default": false }
            }
        },
        "stateV3": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "label", "when"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "label": { "type": "string", "minLength": 1 },
                "when": {
                    "oneOf": [
                        { "$ref": "#/definitions/allCondition" },
                        { "$ref": "#/definitions/anyCondition" }
                    ]
                },
                "extract": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "title": { "$ref": "#/definitions/extractTitle" },
                        "buttons": { "$ref": "#/definitions/extractButtons" }
                    }
                }
            }
        },
        "sectionRegex": {
            "type": "object",
            "additionalProperties": false,
            "required": ["regex"],
            "properties": {
                "section": { "type": "string" },
                "regex": { "type": "string", "minLength": 1 },
                "flags": { "type": "string", "default": "i" },
                "cursor_row_min": { "type": "integer", "minimum": 0 },
                "cursor_row_max": { "type": "integer", "minimum": 0 },
                "cursor_col_min": { "type": "integer", "minimum": 0 },
                "cursor_col_max": { "type": "integer", "minimum": 0 }
            }
        },
        "sectionPattern": {
            "type": "object",
            "additionalProperties": false,
            "required": ["pattern"],
            "properties": {
                "section": { "type": "string" },
                "pattern": { "type": "string", "minLength": 1 },
                "flags": { "type": "string", "default": "" }
            }
        },
        "control": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "label", "action"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "label": { "type": "string", "minLength": 1 },
                "visible_when_state": { "type": "array", "items": { "type": "string" } },
                "action": { "$ref": "#/definitions/controlAction" }
            }
        },
        "controlAction": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "keys"],
                    "properties": {
                        "type": { "const": "send_keys" },
                        "keys": { "type": "string", "minLength": 1 }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "trigger_keys", "wait_for", "extract_choices", "submit_key"],
                    "properties": {
                        "type": { "const": "open_picker" },
                        "trigger_keys": { "type": "string", "minLength": 1 },
                        "wait_for": { "$ref": "#/definitions/sectionRegex" },
                        "extract_choices": { "$ref": "#/definitions/sectionPattern" },
                        "submit_key": { "type": "string", "minLength": 1 }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "method", "keys_template"],
                    "properties": {
                        "type": { "const": "attach_image" },
                        "method": { "const": "tempfile_then_keys" },
                        "keys_template": { "type": "string", "minLength": 1 }
                    }
                }
            ]
        },
        "notification": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "when_state", "title"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "when_state": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1 },
                "body": { "type": "string" }
            }
        },
        "nativeHistory": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "reader": {
                    "type": "string",
                    "enum": ["claude-cli", "codex-cli", "antigravity-cli", "hermes-cli"]
                },
                "source": {
                    "oneOf": [
                        { "$ref": "#/definitions/nativeHistoryJsonlSource" },
                        { "$ref": "#/definitions/nativeHistorySqliteSource" }
                    ]
                },
                "override_path": { "type": "string", "minLength": 1 }
            }
        },
        "nativeHistoryMessageMap": {
            "type": "object",
            "additionalProperties": false,
            "required": ["role", "content"],
            "properties": {
                "role": { "type": "string", "minLength": 1 },
                "content": { "type": "string", "minLength": 1 },
                "content_strip": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "content_unwrap": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "timestamp_ms": { "type": "string", "minLength": 1 },
                "kind": { "type": "string", "minLength": 1 }
            }
        },
        "nativeHistoryJsonlSource": {
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "path", "message_map"],
            "properties": {
                "kind": { "const": "jsonl" },
                "path": { "type": "string", "minLength": 1 },
                "file_pattern": { "type": "string", "minLength": 1 },
                "recent_window_ms": { "type": "integer", "minimum": 0 },
                "session_id_from": { "type": "string", "enum": ["filename_uuid", "first_record"] },
                "session_id_path": { "type": "string", "minLength": 1 },
                "message_filter": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["where"],
                    "properties": { "where": { "type": "string", "minLength": 1 } }
                },
                "message_map": { "$ref": "#/definitions/nativeHistoryMessageMap" }
            }
        },
        "nativeHistorySqliteSource": {
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "path", "session_query", "message_query", "message_map"],
            "properties": {
                "kind": { "const": "sqlite" },
                "path": { "type": "string", "minLength": 1 },
                "session_query": { "type": "string", "minLength": 1 },
                "message_query": { "type": "string", "minLength": 1 },
                "message_map": { "$ref": "#/definitions/nativeHistoryMessageMap" }
            }
        },
        "delegateTrigger": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "when_state", "task_template"],
            "properties": {
                "id": { "type": "string", "minLength": 1, "pattern": "^[a-z][a-z0-9_]*$" },
                "when_state": { "type": "string", "minLength": 1 },
                "after_duration_ms": { "type": "integer", "minimum": 0 },
                "task_template": { "type": "string", "minLength": 1 }
            }
        }
    }
} as const;

/** Default schema export — v3 (current). */
export const SCHEMA = SCHEMA_V3;
