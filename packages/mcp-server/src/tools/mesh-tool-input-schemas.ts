/**
 * Input sub-schemas shared by several mesh tool schemas: the structured task
 * `input` envelope (mesh_send_task / mesh_enqueue_task / mesh_enqueue_batch). A
 * leaf, so the per-domain schema modules can share it
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
 * Support is per-provider and enforced at dispatch, not here: 6 of 7 CLI providers
 * declare image input (opencode does not), and an
 * unsupported target is REFUSED with a provider-named error rather than silently
 * dropping the attachment — a prompt that says "look at this screenshot" must never
 * arrive with no screenshot.
 *
 * Shared by mesh_send_task / mesh_enqueue_task / mesh_enqueue_batch so the three
 * entry points cannot drift in what they accept.
 */
export const MESH_TASK_INPUT_SCHEMA = {
    type: 'object' as const,
    description: 'Multipart input, e.g. a screenshot: {parts:[{type:"text",text},{type:"image",mimeType,data(base64)|uri}]}. A text-only provider (opencode) refuses it explicitly.',
    properties: {
        parts: {
            type: 'array' as const,
            items: { type: 'object' as const },
        },
    },
};
