import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Installed cloud PWA (iOS, black-translucent + viewport-fit=cover): the root
// `html` already reserves env(safe-area-inset-top) under `display-mode:
// standalone` (see pwa-app-shell-viewport-gap.test.ts). The mobile flow headers
// (Inbox, Room, Machine) used to add the same env() again, so the status-bar
// clearance stacked (59px + 16px + 59px on a Dynamic Island phone) and left a
// band of empty dark space above the header. The product `isStandalone` flag
// means "self-hosted app", NOT "installed PWA", so it cannot gate this.
//
// jsdom has no env()/media evaluation, so this asserts the structural
// invariant: exactly one CSS variable carries the flow-header inset, it is the
// raw inset by default and 0 under the same installed query as the root rule,
// and no flow header reads env(safe-area-inset-top) directly. Emulation is not
// real-iOS proof; real-device confirmation is a separate gate.

const WEB_CORE = path.join(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(WEB_CORE, rel), 'utf8')

const HEADERS: Array<{ file: string; base: string }> = [
  { file: 'src/components/dashboard/DashboardMobileChatInbox.tsx', base: '16px' },
  { file: 'src/components/dashboard/DashboardMobileChatRoom.tsx', base: '14px' },
  { file: 'src/components/dashboard/DashboardMobileMachineScreen.tsx', base: '16px' },
]

describe('mobile flow header top inset is consumed once', () => {
  it.each(HEADERS)('$file reads the scoped variable, not env() directly', ({ file, base }) => {
    const tsx = read(file)
    expect(tsx).toContain(`pt-[calc(${base}+var(--mobile-flow-header-safe-top,0px))]`)
    expect(tsx).not.toMatch(/pt-\[calc\(\d+px\+env\(safe-area-inset-top/)
  })

  it('defaults the variable to the raw inset outside the installed query', () => {
    const css = read('src/index.css')
    expect(css).toMatch(/:root\s*\{\s*--mobile-flow-header-safe-top:\s*env\(safe-area-inset-top,\s*0px\);\s*\}/)
  })

  it('zeroes the variable inside the same display-mode: standalone block that pads html', () => {
    const css = read('src/index.css')
    const start = css.indexOf('@media (display-mode: standalone) {')
    expect(start).toBeGreaterThanOrEqual(0)
    const slice = css.slice(start, css.indexOf('/* Touch: remove hover effects', start))
    expect(slice).toMatch(/:root\s*\{\s*--mobile-flow-header-safe-top:\s*0px;\s*\}/)
    expect(slice).toContain('padding-top: env(safe-area-inset-top, 0px);')
  })
})
