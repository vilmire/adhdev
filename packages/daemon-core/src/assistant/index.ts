/**
 * Assistant layer module index (docs/design/2026-10-07-assistant-layer.md).
 *
 * Work-order unit 2(a): the memory store, its write guards and the frozen
 * snapshot renderer. Unit 2(c)/(d)/(f-store): the skill store, index and
 * attach renderers, the curator, and the read-only Hermes import. Not yet wired into sessions, daemon verbs, MCP or the
 * dashboard, and deliberately not re-exported from the daemon-core package
 * barrel until a consumer (the `assistant_memory` verb / launch_assistant
 * prompt builder) lands.
 */

export * from './store-guards.js';
export * from './memory/memory-store.js';
export * from './skills/skill-format.js';
export * from './skills/skill-state.js';
export * from './skills/skill-journal.js';
export * from './skills/skill-write-prep.js';
export * from './skills/skill-store.js';
export * from './skills/skill-index.js';
export * from './skills/skill-curator.js';
export * from './skills/hermes-import.js';
