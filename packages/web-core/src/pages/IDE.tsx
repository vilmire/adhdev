/**
 * IDE Page — legacy compatibility wrapper.
 *
 * The real IDE workflow now lives in Dashboard + Remote dialog.
 * This page stays only so external imports and old routes do not break.
 */
import { Navigate, useParams } from 'react-router-dom'

interface IDEPageProps {
    renderHeaderActions?: (context: { daemonId: string; ideInstanceId: string }) => React.ReactNode
}

export default function IDEPage(_props: IDEPageProps = {}) {
    const { id } = useParams<{ id: string }>()
    if (!id) return <Navigate to="/dashboard" replace />
    return <Navigate to={`/dashboard?activeTab=${encodeURIComponent(id)}`} replace />
}
