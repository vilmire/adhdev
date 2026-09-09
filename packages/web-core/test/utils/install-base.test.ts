// Host-aware install base (G3-2): the installers are channel-stamped per
// serving site, so the HOST in the copyable command decides whether the user
// installs the stable or the preview daemon. These tests pin the branching so
// a regression back to a hardcoded https://adhf.dev (which handed preview
// users a stable daemon) fails loudly.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    getInstallBaseForHost,
    getInstallCommands,
    PROD_INSTALL_BASE,
    PREVIEW_INSTALL_BASE,
} from '../../src/utils/install-base'

describe('getInstallBaseForHost', () => {
    it('production web hosts get the production installer', () => {
        expect(getInstallBaseForHost('adhf.dev')).toBe(PROD_INSTALL_BASE)
        expect(getInstallBaseForHost('adhdev-web.pages.dev')).toBe(PROD_INSTALL_BASE)
    })

    it('localhost targets the production API, so it keeps the production installer', () => {
        expect(getInstallBaseForHost('localhost')).toBe(PROD_INSTALL_BASE)
        expect(getInstallBaseForHost('127.0.0.1')).toBe(PROD_INSTALL_BASE)
    })

    it('every non-production host is a preview surface', () => {
        expect(getInstallBaseForHost('dev.adhf.dev')).toBe(PREVIEW_INSTALL_BASE)
        expect(getInstallBaseForHost('abc123.adhdev-web.pages.dev')).toBe(PREVIEW_INSTALL_BASE)
    })
})

describe('getInstallCommands', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('defaults to the production base without a window (SSR/prerender)', () => {
        const cmds = getInstallCommands()
        expect(cmds.unix.cmd).toBe(`curl -fsSL ${PROD_INSTALL_BASE}/install | sh`)
        expect(cmds.powershell.cmd).toBe(`irm ${PROD_INSTALL_BASE}/install.ps1 | iex`)
        expect(cmds.cmd.cmd).toContain(`${PROD_INSTALL_BASE}/install.cmd`)
    })

    it('preview dashboard hands out the preview installer, not stable', () => {
        vi.stubGlobal('window', { location: { hostname: 'dev.adhf.dev' } })
        const cmds = getInstallCommands()
        expect(cmds.unix.cmd).toBe(`curl -fsSL ${PREVIEW_INSTALL_BASE}/install | sh`)
        expect(cmds.powershell.cmd).toBe(`irm ${PREVIEW_INSTALL_BASE}/install.ps1 | iex`)
        expect(cmds.cmd.cmd).toContain(`${PREVIEW_INSTALL_BASE}/install.cmd`)
        // The stable host must not leak into any preview command
        for (const entry of Object.values(cmds)) {
            expect(entry.cmd).not.toContain('https://adhf.dev/')
        }
    })
})
