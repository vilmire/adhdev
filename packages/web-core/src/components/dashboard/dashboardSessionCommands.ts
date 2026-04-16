export function getPassiveSessionSelectionCommand() {
  return 'select_session' as const
}

export function getExplicitSessionRevealCommand() {
  return 'open_panel' as const
}
