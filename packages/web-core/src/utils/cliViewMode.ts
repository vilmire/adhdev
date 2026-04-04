export function confirmTerminalFit(): boolean {
    if (typeof window === 'undefined') return true
    return window.confirm(
        'Fitting the terminal may resize or visually break some CLI apps.\n\nResize the terminal anyway?'
    )
}
