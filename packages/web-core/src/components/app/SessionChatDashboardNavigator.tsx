/**
 * SessionChatDashboardNavigator — lets an "open this session's chat" request
 * (utils/session-nav) reach the dashboard from a route that has no
 * DashboardMainView mounted (e.g. /mesh).
 *
 * Mounted once by AppShell, which both web-standalone and web-cloud wrap their
 * routes in; both serve the dashboard at `/dashboard`. The bus holds the
 * request, this navigates, and DashboardMainView replays it on mount. Outside
 * a router (isolated renders, tests) it registers nothing, and the bus answers
 * with its "cannot open from here" toast instead of navigating.
 */
import { useEffect } from 'react'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import { registerSessionChatNavigator } from '../../utils/session-nav'

export const SESSION_CHAT_DASHBOARD_PATH = '/dashboard'

function RouterSessionChatNavigator({ path }: { path: string }) {
    const navigate = useNavigate()
    useEffect(() => registerSessionChatNavigator(() => navigate(path)), [navigate, path])
    return null
}

export default function SessionChatDashboardNavigator({ path = SESSION_CHAT_DASHBOARD_PATH }: { path?: string }) {
    const inRouter = useInRouterContext()
    return inRouter ? <RouterSessionChatNavigator path={path} /> : null
}
