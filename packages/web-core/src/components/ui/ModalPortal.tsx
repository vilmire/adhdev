/**
 * ModalPortal — bare portal-to-<body> primitive for hand-built modal overlays.
 *
 * `<Dialog>` is the canonical modal shell for new code, but a number of
 * existing modals have their own bespoke overlay markup (custom header/body/
 * footer layout, non-standard close affordances) that isn't worth reshaping
 * onto Dialog's props just to fix stacking. Those modals render a
 * `fixed inset-0 …` overlay inline in the component tree; if a call site ever
 * lands inside an ancestor with `backdrop-filter`/`filter`/`transform`/
 * `contain`, that ancestor becomes the fixed element's containing block per
 * the CSS spec, and the overlay centers on the ancestor's box instead of the
 * viewport (see LaunchConfirmDialog's fix for a concrete instance).
 *
 * Wrap the overlay root in `<ModalPortal>` to render it into document.body
 * unconditionally, without changing its markup or behavior.
 *
 * SSR / test-safe: when `document` is unavailable (Node/vitest render) the
 * children render inline instead of through a portal, so
 * renderToStaticMarkup works without a DOM — same rule as Dialog.tsx.
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export default function ModalPortal({ children }: { children: ReactNode }) {
    if (typeof document === 'undefined') return <>{children}</>
    return createPortal(children, document.body)
}
