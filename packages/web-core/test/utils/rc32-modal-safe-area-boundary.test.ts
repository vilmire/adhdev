import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

function readPkgSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../', relativePath), 'utf8')
}

// RC32 mobile PWA close-control / safe-area audit: every modal that ships a
// fixed-position root in the iOS installed PWA (viewport-fit=cover) must use
// the canonical z-index token, dvh sizing, safe-area-aware padding, and a
// reachable >=44px close affordance — without raw z-50 stacking hacks.
describe('RC32 modal safe-area hardening (audited peers)', () => {
  it('GitStatusDialog uses the modal z-token, dvh sizing, safe-area padding, Escape, and a 44px close', () => {
    const source = readSource('components/git/GitStatusDialog.tsx')

    expect(source).toContain('z-[var(--z-modal)]')
    expect(source).not.toContain('z-50')
    expect(source).toContain('h-[80dvh]')
    expect(source).not.toContain('h-[80vh]')
    expect(source).toContain('pt-[calc(16px+env(safe-area-inset-top,0px))]')
    expect(source).toContain("event.key !== 'Escape'")
    // Escape closes the inline confirmation overlay before the dialog itself.
    expect(source).toContain('if (pendingAction) cancelAction()')
    expect(source).toContain('h-11 w-11')
    expect(source).toContain('aria-label="Close"')
  })

  it('ProviderFixModal / ProviderCloneModal use the modal z-token and a usable close target', () => {
    const fixSource = readSource('pages/machine/ProviderFixModal.tsx')
    const cloneSource = readSource('pages/machine/ProviderCloneModal.tsx')

    for (const source of [fixSource, cloneSource]) {
      expect(source).toContain('z-[var(--z-modal)]')
      expect(source).not.toContain('z-50')
      expect(source).toContain('aria-label="Close"')
      expect(source).toContain('h-11 w-11')
    }
    // Clone modal previously had NO header close button at all.
    expect(cloneSource).toContain('flex items-start justify-between gap-3')
  })

  it('DashboardMobileSessionHostSheet sizes against dvh and clears the safe-area top', () => {
    const source = readSource('components/dashboard/DashboardMobileSessionHostSheet.tsx')

    expect(source).toContain('max-h-[88dvh]')
    expect(source).toContain('max-h-[calc(88dvh-122px)]')
    expect(source).not.toContain('88vh')
    expect(source).toContain('pt-[env(safe-area-inset-top,0px)]')
  })

  it('LaunchPickModal dismisses via backdrop click and Escape in addition to Cancel', () => {
    const source = readSource('pages/machine/LaunchPickModal.tsx')

    expect(source).toContain('onClick={() => setLaunchPick(null)}')
    expect(source).toContain('event.stopPropagation()')
    expect(source).toContain("event.key === 'Escape'")
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
  })

  it('OnboardingModal caps height inside the safe area, scrolls, and closes on Escape with a 44px target', () => {
    const source = readSource('components/OnboardingModal.tsx')

    expect(source).toContain("event.key === 'Escape'")
    expect(source).toContain('100dvh')
    expect(source).toContain('env(safe-area-inset-top')
    expect(source).toContain("overflowY: 'auto'")
    expect(source).toContain('minWidth: 44')
    expect(source).toContain('minHeight: 44')
    expect(source).toContain('aria-label="Close onboarding"')
  })

  it('keeps the mesh observability dialog inside both PWA safe-area edges without forcing empty mobile height', () => {
    const dialogSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
    const themeSource = readSource('components/MeshGraph/meshGraphTheme.ts')

    expect(dialogSource).toContain('<DialogShell')
    expect(dialogSource).toContain('overlayClassName={meshTheme.dialogOverlayClass}')
    expect(themeSource.match(/pt-\[calc\(16px\+env\(safe-area-inset-top,0px\)\)\]/g)).toHaveLength(2)
    expect(themeSource.match(/pb-\[calc\(16px\+env\(safe-area-inset-bottom,0px\)\)\]/g)).toHaveLength(2)
    expect(themeSource.match(/max-h-\[calc\(100dvh-env\(safe-area-inset-top,0px\)-env\(safe-area-inset-bottom,0px\)-2rem\)\]/g)).toHaveLength(2)
    expect(themeSource).not.toContain('pt-[max(8px,env(safe-area-inset-top,0px))]')
    expect(themeSource).not.toContain('flex h-full max-h-full w-full')
  })

  it('the mesh DetailModal uses the capture-phase single-level Escape handler', () => {
    const overviewSource = readSource('components/MeshGraph/MeshOverviewCards.tsx')
    const parentSource = readSource('components/dashboard/DashboardMeshGraphDialog.tsx')
    const escapeSource = readSource('utils/modal-escape.ts')

    expect(overviewSource).toContain('installTopModalEscapeHandler(window, onClose)')
    expect(escapeSource).toContain("target.addEventListener('keydown', onKeyDown, true)")
    expect(escapeSource).toContain('event.stopPropagation()')
    // The parent dialog keeps its plain bubble-phase listener — the ordering
    // contract (capture child runs first, stops propagation) depends on it.
    expect(parentSource).toContain("window.addEventListener('keydown', handleKeyDown)")
    expect(parentSource).not.toContain("window.addEventListener('keydown', handleKeyDown, true)")
  })

  it('keeps the top toast stack and connection banner out of the mobile modal header band', () => {
    const toastSource = readSource('components/dashboard/ToastContainer.tsx')
    const bannerSource = readSource('components/dashboard/ConnectionBanner.tsx')

    // z-toast intentionally stacks above z-modal for visibility; the mobile
    // top offset must clear the fullscreen modal header (safe-area + 64px) so
    // an interactive toast/banner can never make a close control untappable.
    for (const source of [toastSource, bannerSource]) {
      expect(source).toContain('top-[calc(env(safe-area-inset-top,0px)+64px)]')
      expect(source).toContain('sm:top-[calc(env(safe-area-inset-top,0px)+16px)]')
    }
    // Non-toast regions of the stack container never intercept pointer events.
    expect(toastSource).toContain('pointer-events-none')
    expect(bannerSource).toContain('pointer-events-none')
  })

  it('leaves web-standalone without viewport-fit=cover while the isStandalone safe-area ownership split stands', () => {
    // Deferred redesign boundary: web-core's mobile chrome still keys safe-area
    // padding off `isStandalone` (e.g. DashboardMobileMachineScreen), and the
    // standalone host has no install manifest (not an installable PWA). Flipping
    // viewport-fit=cover here would move the safe-area insets without updating
    // those call sites — that ownership redesign is explicitly out of RC32 scope.
    const standaloneHtml = readPkgSource('../web-standalone/index.html')
    const machineScreenSource = readSource('components/dashboard/DashboardMobileMachineScreen.tsx')

    expect(standaloneHtml).not.toContain('viewport-fit=cover')
    expect(machineScreenSource).toContain('isStandalone')
    expect(machineScreenSource).toContain('env(safe-area-inset-top,0px)')
  })
})
