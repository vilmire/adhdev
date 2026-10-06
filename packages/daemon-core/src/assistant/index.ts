/**
 * Assistant layer module index (docs/design/2026-10-07-assistant-layer.md).
 *
 * Work-order unit 2(a): the memory store, its write guards and the frozen
 * snapshot renderer. Unit 2(c)/(d)/(f-store): the skill store, index and
 * attach renderers, the curator, and the read-only Hermes import. Unit 2(b)/(e):
 * the input log (write-origin source), project addressing, staged project
 * notes, the review-turn trigger/whitelist, and the per-daemon store
 * instances the store verbs (commands/high-family/assistant-store.ts) use.
 * Unit 3 cores: the system prompt builder, the `assistant.json` registry and
 * the relay (ports only; boot wiring pending).
 * Not yet wired into sessions, MCP or the dashboard, and deliberately not
 * re-exported from the daemon-core package barrel: the only consumers are
 * in-package (the store verbs now, launch_assistant / the relay later).
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
export * from './assistant-input-log.js';
export * from './assistant-review.js';
export * from './assistant-projects.js';
export * from './note-staging.js';
export * from './assistant-services.js';
export * from './assistant-prompt.js';
export * from './assistant-registry.js';
export * from './assistant-relay-format.js';
export * from './assistant-relay-store.js';
export * from './assistant-relay-sqlite-store.js';
export * from './assistant-relay.js';
export * from './coordinator-lifecycle.js';
export * from './project-message.js';
export * from './discover-repos.js';
export * from './project-views.js';
export * from './assistant-project-ports.js';
