export const DEFAULT_MIN_CLI_TERMINAL_SCALE = 0.5
export const DEFAULT_MAX_CLI_TERMINAL_SCALE = 1.15

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getAutoCliTerminalScaleForWidth(
  width: number,
  options: { minScale?: number } = {},
): number {
  const minScale = typeof options.minScale === 'number' ? options.minScale : DEFAULT_MIN_CLI_TERMINAL_SCALE
  if (!Number.isFinite(width) || width <= 0) return 1
  if (width <= 480) return minScale
  return 1
}

export function getAutoCliTerminalScaleForViewport(
  width: number,
  height: number,
  options: { minScale?: number; maxScale?: number } = {},
): number {
  const minScale = typeof options.minScale === 'number' ? options.minScale : DEFAULT_MIN_CLI_TERMINAL_SCALE
  const maxScale = typeof options.maxScale === 'number' ? options.maxScale : DEFAULT_MAX_CLI_TERMINAL_SCALE
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return 1

  if (width <= 480) {
    const mobileHeightRatio = height / 760
    return Number(clamp(mobileHeightRatio, minScale, 0.82).toFixed(2))
  }

  const widthRatio = width / 960
  const heightRatio = height / 720
  return Number(clamp(Math.min(widthRatio, heightRatio), minScale, maxScale).toFixed(2))
}

export function shouldPreferFitCliTerminal(
  width: number,
  height: number,
): boolean {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return false
  if (width <= 480) return true
  if (width <= 640 && height <= 760) return true
  if (width <= 900 && height <= 700 && width < height) return true
  return false
}
