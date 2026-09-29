/**
 * Input sub-schemas shared by several mesh tool schemas: the structured task
 * `input` envelope (mesh_send_task / mesh_enqueue_task / mesh_enqueue_batch) and
 * the graph input binding. A leaf, so the per-domain schema modules can share it
 * without an import cycle through the ALL_MESH_TOOLS registry.
 */

/**
 * MESH-IMAGE-DISPATCH: optional structured input accompanying a task instruction.
 *
 * `message` stays the required, unchanged text channel — every existing caller and
 * every text-only task behaves exactly as before. `input` is strictly ADDITIVE: when
 * present it carries a multipart envelope (e.g. a screenshot) that is delivered to the
 * worker's provider instance instead of being flattened to text.
 *
 * Support is per-provider and enforced at dispatch, not here: 7 of 8 CLI providers
 * declare image input (opencode does not), and every ACP provider is text-only. An
 * unsupported target is REFUSED with a provider-named error rather than silently
 * dropping the attachment — a prompt that says "look at this screenshot" must never
 * arrive with no screenshot.
 *
 * Shared by mesh_send_task / mesh_enqueue_task / mesh_enqueue_batch so the three
 * entry points cannot drift in what they accept.
 */
export const MESH_TASK_INPUT_SCHEMA = {
    type: 'object' as const,
    description: 'Multipart input, e.g. a screenshot: {parts:[{type:"text",text},{type:"image",mimeType,data(base64)|uri}]}. A text-only provider (opencode, ACP) refuses it explicitly.',
    properties: {
        parts: {
            type: 'array' as const,
            items: { type: 'object' as const },
        },
    },
};

/**
 * One `inputs_from` entry (design :204-246).
 *
 * ★ This schema used to be a bare `{ type: 'object' }` — the field shapes lived
 * ONLY in the prose description, so nothing machine-readable told a caller that
 * `from`/`select`/`as` are mandatory. daemon-core's `parseInputBindings` is
 * strict about all three, so a plausible-looking typo was accepted by the tool
 * boundary and rejected much later, during materialization. The schema now
 * states the contract the parser already enforces; daemon-core re-validates at
 * enqueue regardless (a schema is a hint to the model, never the boundary).
 *
 * Kept deliberately in step with `parseInputBindings`: same required fields,
 * same `as` pattern, same enums, same `max_bytes` ceiling. Descriptions are
 * terse on purpose (graph-orchestration-simplification D2: the batch schema is
 * size-capped, see mesh-enqueue-schema-diet.test.ts).
 */
export const MESH_INPUT_BINDING_SCHEMA = {
    type: 'object' as const,
    properties: {
        from: { type: 'string' as const, description: 'Predecessor task/gate ref.' },
        select: { type: 'string' as const, description: 'RFC-6901 JSON Pointer into its completion envelope, e.g. /summary ("" = all).' },
        as: { type: 'string' as const, pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$', description: 'Unique binding name.' },
        required: { type: 'boolean' as const, description: 'true = block when empty.' },
        format: { type: 'string' as const, enum: ['text', 'json'] },
        // Snake_case ONLY — unlike the task-level fields, `parseInputBindings`
        // reads no camelCase alias for these, so advertising one would publish a
        // field the parser silently ignores.
        max_bytes: { type: 'number' as const, description: 'Default 16384, max 65536.' },
        overflow: { type: 'string' as const, enum: ['error', 'truncate'] },
    },
    required: ['from', 'select', 'as'],
};
