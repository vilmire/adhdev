/**
 * Legacy route `/needs-you` — the "To do" surface is a drawer now, not a page. Old links (push
 * notification targets, chat auto-links, bookmarks) keep working: redirect to the dashboard with
 * the same query plus `todo=1`, which opens the drawer focused on the linked card.
 */
import { Navigate, useLocation } from 'react-router-dom'
import { withTodoDrawer } from '../components/needs-you/needs-you-model'

export default function NeedsYouRedirect() {
    const { search } = useLocation()
    return <Navigate to={{ pathname: '/dashboard', search: withTodoDrawer(search) }} replace />
}
