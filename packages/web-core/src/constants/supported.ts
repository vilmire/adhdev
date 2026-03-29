/**
 * Supported providers — single source of truth
 *
 * Used by Landing, About, StandaloneAbout, and any UI that lists supported IDEs/CLIs/Extensions.
 * For the dynamic registry (Capabilities page), see registry.json in adhdev-providers.
 */

export interface SupportedEntry {
    id: string
    name: string
    icon: string
}

export const SUPPORTED_IDES: readonly SupportedEntry[] = [
    { id: 'vscode', name: 'VS Code', icon: '💙' },
    { id: 'cursor', name: 'Cursor', icon: '⚡' },
    { id: 'windsurf', name: 'Windsurf', icon: '🏄' },
    { id: 'antigravity', name: 'Antigravity', icon: '🌀' },
    { id: 'trae', name: 'Trae', icon: '🔮' },
    { id: 'kiro', name: 'Kiro', icon: '🎯' },
    { id: 'pearai', name: 'PearAI', icon: '🍐' },
    { id: 'vscodium', name: 'VSCodium', icon: '💚' },
] as const

export const SUPPORTED_CLI_AGENTS: readonly SupportedEntry[] = [
    { id: 'claude-cli', name: 'Claude Code', icon: '🟠' },
    { id: 'gemini-cli', name: 'Gemini CLI', icon: '✨' },
    { id: 'codex-cli', name: 'Codex CLI', icon: '📦' },
] as const

export const SUPPORTED_EXTENSIONS: readonly SupportedEntry[] = [
    { id: 'copilot', name: 'GitHub Copilot', icon: '🤖' },
    { id: 'cline', name: 'Cline', icon: '🧠' },
    { id: 'roo-code', name: 'Roo Code', icon: '🦘' },
    { id: 'continue', name: 'Continue', icon: '▶️' },
] as const

/** ACP agent count (approximate, for display purposes) */
export const SUPPORTED_ACP_COUNT = 35
