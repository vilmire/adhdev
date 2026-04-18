export const DEFAULT_MIN_CLI_TERMINAL_SCALE = 0.6
export const DEFAULT_MAX_CLI_TERMINAL_SCALE = 1.15

export function getAutoCliTerminalScaleForWidth(
  width: number,
  options: { minScale?: number } = {},
): number {
  const minScale = typeof options.minScale === 'number' ? options.minScale : DEFAULT_MIN_CLI_TERMINAL_SCALE
  if (!Number.isFinite(width) || width <= 0) return 1
  if (width <= 480) return minScale
  return 1
}
