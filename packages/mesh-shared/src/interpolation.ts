/**
 * Pure {{key}} template interpolation shared by the mesh command paths.
 *
 * Hoisted from packages/daemon-cloud/src/mesh/mesh-interpolation.ts — the
 * substitution is transport-agnostic (plain string/object work), so it belongs
 * in the dependency-free mesh-shared leaf where standalone can reuse it too.
 * The substitution semantics are byte-for-byte identical to the prior cloud copy.
 */
export function interpolateArgs(
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    result[k] = typeof v === 'string' ? interpolateString(v, context) : v;
  }
  return result;
}

export function interpolateString(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = ctx[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}
