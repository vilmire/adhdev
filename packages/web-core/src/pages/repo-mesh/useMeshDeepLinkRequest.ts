import { useCallback, useMemo } from 'react'
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom'
import { parseMeshDeepLink, type MeshDeepLink } from '../../utils/mesh-deep-link'

/**
 * The `/mesh?mesh=…&tab=…&task=…` request a chat id link left in the URL, plus `consume`
 * to strip it once the page acted on it (so a reload does not re-open the dialog). Router
 * presence never changes while the page is mounted, which is what makes the conditional
 * hook calls below safe; outside a router the hook is inert (isolated page tests).
 */
export function useMeshDeepLinkRequest(): { request: MeshDeepLink | null; consume: () => void } {
    const inRouter = useInRouterContext()
    /* eslint-disable react-hooks/rules-of-hooks */
    const search = inRouter ? useLocation().search : ''
    const navigate = inRouter ? useNavigate() : null
    /* eslint-enable react-hooks/rules-of-hooks */
    const request = useMemo(() => parseMeshDeepLink(search), [search])
    const consume = useCallback(() => { navigate?.('/mesh', { replace: true }) }, [navigate])
    return { request, consume }
}
