/**
 * installTopModalEscapeHandler — Escape-to-close for a modal that is stacked
 * on top of another shell which ALSO listens for Escape on `window`
 * (e.g. the mesh overview DetailModal rendered inside DashboardMeshGraphDialog).
 *
 * The parent shell registered its bubble-phase `window` keydown listener first,
 * so a plain bubble listener in the child would run AFTER the parent already
 * closed — one Escape would tear down both levels. Registering in the capture
 * phase and calling `stopPropagation()` halts the event before it reaches any
 * bubble-phase listener, so one Escape closes exactly one modal level.
 *
 * Returns the cleanup function (pass to useEffect's return).
 */
export function installTopModalEscapeHandler(
    target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    onClose: () => void,
): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onClose()
    }
    target.addEventListener('keydown', onKeyDown, true)
    return () => target.removeEventListener('keydown', onKeyDown, true)
}
