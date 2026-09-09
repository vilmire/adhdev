/**
 * Install-command base URL — host-aware so preview-dashboard users get the
 * preview installer instead of silently installing the stable daemon.
 *
 * The installers under the web app's public/ are channel-stamped at build time
 * (stable for adhf.dev, preview for dev.adhf.dev), so WHICH host the command
 * curls decides which channel the user ends up on. Hardcoding https://adhf.dev
 * in the UI therefore handed every preview user a stable daemon.
 *
 * Host branching mirrors the cloud dashboard's getApiBase(): only production
 * web hosts get the production installer; localhost targets the production API
 * and keeps the production installer; every other host is a preview surface
 * and points at dev.adhf.dev.
 */

export const PROD_INSTALL_BASE = 'https://adhf.dev'
export const PREVIEW_INSTALL_BASE = 'https://dev.adhf.dev'

export function getInstallBaseForHost(host: string): string {
    if (host === 'adhf.dev' || host === 'adhdev-web.pages.dev') return PROD_INSTALL_BASE
    if (host === 'localhost' || host === '127.0.0.1') return PROD_INSTALL_BASE
    return PREVIEW_INSTALL_BASE
}

export function getInstallBase(): string {
    if (typeof window === 'undefined') return PROD_INSTALL_BASE
    return getInstallBaseForHost(window.location.hostname)
}

export interface InstallCommandEntry {
    cmd: string
    shell: string
    prompt: string
}

export type InstallShellType = 'unix' | 'powershell' | 'cmd'

export function getInstallCommands(): Record<InstallShellType, InstallCommandEntry> {
    const base = getInstallBase()
    return {
        unix: { cmd: `curl -fsSL ${base}/install | sh`, shell: 'Terminal', prompt: '$ ' },
        powershell: { cmd: `irm ${base}/install.ps1 | iex`, shell: 'PowerShell', prompt: 'PS> ' },
        cmd: { cmd: `curl -fsSL ${base}/install.cmd -o %TEMP%\\adhdev.cmd && %TEMP%\\adhdev.cmd`, shell: 'CMD', prompt: '> ' },
    }
}
