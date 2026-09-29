
export function interpolateString(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = ctx[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}
