export const DEFAULT_SESSION_HOST_COLS = 80;
export const DEFAULT_SESSION_HOST_ROWS = 48;

function normalizeSessionHostDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

export function resolveSessionHostCols(value: number | undefined): number {
  return normalizeSessionHostDimension(value, DEFAULT_SESSION_HOST_COLS);
}

export function resolveSessionHostRows(value: number | undefined): number {
  return normalizeSessionHostDimension(value, DEFAULT_SESSION_HOST_ROWS);
}
