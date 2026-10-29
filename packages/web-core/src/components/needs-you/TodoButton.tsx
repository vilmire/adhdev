/**
 * Header button for the "To do" drawer: a checklist icon with a count badge (open decisions +
 * approvals — the same number the old nav item showed). Mounted in the dashboard header, the
 * mobile top bars and, as a floating fallback (`TodoDrawerHost`), on every other screen.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useInRouterContext } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useNeedsYouCount } from '../../context/NeedsYouContext'
import { useTodoDrawer } from '../../hooks/useTodoDrawer'
import { IconCheckCircle } from '../Icons'
import { cn } from '../../lib/utils'

// How many TodoButtons are mounted: the host shows its floating fallback only at zero.
let mounted = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
export function useTodoButtonMountedCount(): number {
    return useSyncExternalStore(
        cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
        () => mounted,
        () => 0,
    )
}

export default function TodoButton(props: { className?: string; size?: number; floating?: boolean }) {
    // The drawer is URL-driven, so without a router (isolated renders of a header) there is nothing to open.
    return useInRouterContext() ? <TodoButtonInner {...props} /> : null
}

function TodoButtonInner({ className, size = 16, floating }: { className?: string; size?: number; floating?: boolean }) {
    const { t } = useTranslation('common')
    const count = useNeedsYouCount()
    const { open, toggleDrawer } = useTodoDrawer()
    useEffect(() => {
        if (floating) return
        mounted++; emit()
        return () => { mounted--; emit() }
    }, [floating])
    const title = t('needsYou.openTitle', { count })
    return (
        <button
            type="button"
            onClick={toggleDrawer}
            className={cn('btn btn-icon relative min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0', className)}
            title={title}
            aria-label={title}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-testid="todo-button"
            data-todo-count={count}
        >
            <IconCheckCircle size={size} />
            {count > 0 && (
                <span
                    className="absolute -top-1 -right-1 min-w-[16px] rounded-full px-1 text-3xs font-bold tabular-nums leading-4 text-center"
                    style={{ background: 'var(--status-warning)', color: 'var(--bg-base, #000)' }}
                    data-testid="todo-button-badge"
                >{count > 99 ? '99+' : count}</span>
            )}
        </button>
    )
}
