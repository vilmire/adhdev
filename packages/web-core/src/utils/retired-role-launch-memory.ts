/** One-way cleanup of retired browser role defaults. Never supplies launch intent. */
export function removeRetiredRoleLaunchMemory(): void {
    try {
        if (localStorage.getItem('adhdev_assistant_launch_choice') !== null) localStorage.removeItem('adhdev_assistant_launch_choice')
        const key = 'adhdev.remember.new-session-mesh'
        const raw = localStorage.getItem(key)
        if (!raw) return
        const prior = JSON.parse(raw)
        if (!prior || typeof prior !== 'object' || Array.isArray(prior)) { localStorage.removeItem(key); return }
        if (!['cliType', 'model', 'thinkingLevel'].some(field => Object.prototype.hasOwnProperty.call(prior, field))) return
        delete prior.cliType
        delete prior.model
        delete prior.thinkingLevel
        localStorage.setItem(key, JSON.stringify(prior))
    } catch { /* Cleanup is best-effort; no role reads use these keys. */ }
}
