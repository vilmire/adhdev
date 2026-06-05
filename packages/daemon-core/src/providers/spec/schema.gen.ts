/**
 * Auto-generated. Mirrors schema.json — regenerate after editing.
 */
export const SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "adhdev:cli/spec@1",
    "title": "ADHDev CLI provider spec",
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
        "id": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[a-z][a-z0-9-]*$"
        },
        "name": {
            "type": "string",
            "minLength": 1
        },
        "binary": {
            "type": "string",
            "minLength": 1
        },
        "spawn_args": {
            "type": "array",
            "items": {
                "type": "string"
            },
            "default": []
        },
        "env": {
            "type": "object",
            "additionalProperties": {
                "type": "string"
            },
            "default": {}
        },
        "send_message": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "submit_key"
            ],
            "properties": {
                "submit_key": {
                    "type": "string",
                    "minLength": 1
                },
                "delay_ms_before_submit": {
                    "type": "integer",
                    "minimum": 0
                },
                "delay_ms_per_char": {
                    "type": "integer",
                    "minimum": 0
                }
            }
        },
        "layout": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "sections"
            ],
            "properties": {
                "sections": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "$ref": "#/definitions/section"
                    }
                }
            }
        },
        "states": {
            "type": "array",
            "minItems": 1,
            "items": {
                "$ref": "#/definitions/state"
            }
        },
        "default_state": {
            "type": "string",
            "minLength": 1
        },
        "control_bar": {
            "type": "array",
            "default": [],
            "items": {
                "$ref": "#/definitions/control"
            }
        },
        "notifications": {
            "type": "array",
            "default": [],
            "items": {
                "$ref": "#/definitions/notification"
            }
        },
        "delegate": {
            "type": "array",
            "default": [],
            "items": {
                "$ref": "#/definitions/delegateTrigger"
            }
        },
        "native_history": {
            "$ref": "#/definitions/nativeHistory"
        }
    },
    "definitions": {
        "size": {
            "oneOf": [
                {
                    "type": "integer",
                    "minimum": 0
                },
                {
                    "type": "string",
                    "pattern": "^\\d+(\\.\\d+)?%$"
                }
            ]
        },
        "section": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "id"
            ],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[a-z][a-z0-9_]*$"
                },
                "from_top": {
                    "$ref": "#/definitions/size"
                },
                "from_bottom": {
                    "$ref": "#/definitions/size"
                },
                "until": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "section"
                    ],
                    "properties": {
                        "section": {
                            "type": "string"
                        }
                    }
                }
            }
        },
        "sectionRegex": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "regex"
            ],
            "properties": {
                "section": {
                    "type": "string"
                },
                "regex": {
                    "type": "string",
                    "minLength": 1
                },
                "flags": {
                    "type": "string",
                    "default": "i"
                }
            }
        },
        "sectionPattern": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "pattern"
            ],
            "properties": {
                "section": {
                    "type": "string"
                },
                "pattern": {
                    "type": "string",
                    "minLength": 1
                },
                "flags": {
                    "type": "string",
                    "default": ""
                }
            }
        },
        "state": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "id",
                "label",
                "when"
            ],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[a-z][a-z0-9_]*$"
                },
                "label": {
                    "type": "string",
                    "minLength": 1
                },
                "when": {
                    "$ref": "#/definitions/sectionRegex"
                },
                "extract_title": {
                    "$ref": "#/definitions/sectionRegex"
                },
                "modal_buttons": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "pattern",
                        "key_for_index"
                    ],
                    "properties": {
                        "section": {
                            "type": "string"
                        },
                        "pattern": {
                            "type": "string",
                            "minLength": 1
                        },
                        "flags": {
                            "type": "string"
                        },
                        "key_for_index": {
                            "type": "string",
                            "minLength": 1
                        },
                        "min_count": {
                            "type": "integer",
                            "minimum": 1,
                            "default": 2
                        }
                    }
                }
            }
        },
        "control": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "id",
                "label",
                "action"
            ],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[a-z][a-z0-9_]*$"
                },
                "label": {
                    "type": "string",
                    "minLength": 1
                },
                "visible_when_state": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "action": {
                    "$ref": "#/definitions/controlAction"
                }
            }
        },
        "controlAction": {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "type",
                        "keys"
                    ],
                    "properties": {
                        "type": {
                            "const": "send_keys"
                        },
                        "keys": {
                            "type": "string",
                            "minLength": 1
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "type",
                        "trigger_keys",
                        "wait_for",
                        "extract_choices",
                        "submit_key"
                    ],
                    "properties": {
                        "type": {
                            "const": "open_picker"
                        },
                        "trigger_keys": {
                            "type": "string",
                            "minLength": 1
                        },
                        "wait_for": {
                            "$ref": "#/definitions/sectionRegex"
                        },
                        "extract_choices": {
                            "$ref": "#/definitions/sectionPattern"
                        },
                        "submit_key": {
                            "type": "string",
                            "minLength": 1
                        }
                    }
                },
                {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "type",
                        "method",
                        "keys_template"
                    ],
                    "properties": {
                        "type": {
                            "const": "attach_image"
                        },
                        "method": {
                            "const": "tempfile_then_keys"
                        },
                        "keys_template": {
                            "type": "string",
                            "minLength": 1
                        }
                    }
                }
            ]
        },
        "notification": {
            "type": "object",
            "additionalProperties": false,
            "required": [
                "id",
                "when_state",
                "title"
            ],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[a-z][a-z0-9_]*$"
                },
                "when_state": {
                    "type": "string",
                    "minLength": 1
                },
                "title": {
                    "type": "string",
                    "minLength": 1
                },
                "body": {
                    "type": "string"
                }
            }
        },
        "nativeHistory": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "reader": {
                    "type": "string",
                    "enum": [
                        "claude-cli",
                        "codex-cli",
                        "antigravity-cli",
                        "hermes-cli"
                    ]
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
                "content_strip": {
                    "type": "array",
                    "items": { "type": "string", "minLength": 1 }
                },
                "content_unwrap": {
                    "type": "array",
                    "items": { "type": "string", "minLength": 1 }
                },
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
            "required": [
                "id",
                "when_state",
                "task_template"
            ],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[a-z][a-z0-9_]*$"
                },
                "when_state": {
                    "type": "string",
                    "minLength": 1
                },
                "after_duration_ms": {
                    "type": "integer",
                    "minimum": 0
                },
                "task_template": {
                    "type": "string",
                    "minLength": 1
                }
            }
        }
    }
} as const;
