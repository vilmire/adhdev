import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readCore(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

function readTop(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../../../../', relativePath), 'utf8')
}

describe('shared app shell boundary', () => {
  it('moves mobile-menu and sidebar-collapse shell state into a shared web-core AppShell while cloud and standalone layouts become wrappers', () => {
    const webCoreIndex = readCore('index.ts')
    const cloudLayout = readTop('packages/web-cloud/src/components/Layout.tsx')
    const standaloneLayout = readTop('oss/packages/web-standalone/src/StandaloneLayout.tsx')
    const appShell = readCore('components/app/AppShell.tsx')

    expect(webCoreIndex).toContain("export { default as AppShell } from './components/app/AppShell'")

    expect(cloudLayout).toContain('AppShell')
    expect(standaloneLayout).toContain('AppShell')

    expect(cloudLayout).not.toContain('const [mobileMenuOpen, setMobileMenuOpen] = useState(false)')
    expect(standaloneLayout).not.toContain('const [mobileMenuOpen, setMobileMenuOpen] = useState(false)')
    expect(cloudLayout).not.toContain('const [collapsed, setCollapsed] = useState(() => {')
    expect(standaloneLayout).not.toContain('const [collapsed, setCollapsed] = useState(() => {')

    expect(appShell).toContain('const [mobileMenuOpen, setMobileMenuOpen] = useState(false)')
    expect(appShell).toContain("collapsedStorageKey = 'sidebar-collapsed'")
    expect(appShell).toContain("localStorage.getItem(collapsedStorageKey) === '1'")
    expect(appShell).toContain('className="mobile-menu-btn"')
    expect(appShell).toContain('className="sidebar-overlay"')
    expect(appShell).toContain('className={`sidebar ${mobileMenuOpen ? \'sidebar-open\' : \'\'}`}')
  })
})
