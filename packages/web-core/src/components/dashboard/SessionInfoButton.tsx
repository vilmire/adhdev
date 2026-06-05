/**
 * SessionInfoButton — the ⓘ icon next to a chat header. Opens SessionInfoDialog
 * when clicked. Renders nothing when sessionId is empty so it can be dropped
 * into headers unconditionally without a wrapping guard at every call site.
 */

import { useState } from 'react'
import SessionInfoDialog from './SessionInfoDialog'

interface Props {
    sessionId: string | undefined
    daemonId: string | undefined
}

export default function SessionInfoButton({ sessionId, daemonId }: Props) {
    const [open, setOpen] = useState(false)
    if (!sessionId || !daemonId) return null
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title="Session info — system prompt, MCP config, spawned at, …"
                aria-label="Session info"
                className="inline-flex items-center justify-center w-6 h-6 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface-secondary text-sm leading-none"
                /* The parent activity-toggle-bar disables pointer events so the
                   floating overlay doesn't steal clicks from the chat body
                   underneath. Re-enable them on the button itself or the click
                   never lands. */
                style={{ pointerEvents: 'auto' }}
            >
                ⓘ
            </button>
            {open && <SessionInfoDialog sessionId={sessionId} daemonId={daemonId} onClose={() => setOpen(false)} />}
        </>
    )
}
