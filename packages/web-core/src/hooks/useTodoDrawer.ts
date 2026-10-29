/**
 * The "To do" drawer's open state lives in the URL (`?todo=1`, plus the deep-link params
 * `mesh` / `decision` / `choose`), so it works on every route, survives a reload, and a push
 * notification or chat auto-link can open it with one navigation. `/needs-you` redirects here.
 */
import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isTodoDrawerOpen, withTodoDrawer, withoutTodoDrawer } from '../components/needs-you/needs-you-model'

export function useTodoDrawer(): { open: boolean; openDrawer: () => void; closeDrawer: () => void; toggleDrawer: () => void } {
    const location = useLocation()
    const navigate = useNavigate()
    const open = useMemo(() => isTodoDrawerOpen(location.search), [location.search])
    const { pathname, search, hash } = location
    const openDrawer = useCallback(() => {
        navigate({ pathname, search: withTodoDrawer(search), hash }, { replace: false })
    }, [navigate, pathname, search, hash])
    const closeDrawer = useCallback(() => {
        navigate({ pathname, search: withoutTodoDrawer(search), hash }, { replace: true })
    }, [navigate, pathname, search, hash])
    const toggleDrawer = useCallback(() => { if (open) closeDrawer(); else openDrawer() }, [open, openDrawer, closeDrawer])
    return { open, openDrawer, closeDrawer, toggleDrawer }
}
