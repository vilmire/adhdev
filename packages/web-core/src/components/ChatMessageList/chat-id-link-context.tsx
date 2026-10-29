/**
 * chat-id-link-context — light half of the chat id links: the context the rows read,
 * the rendered link, and the plain-text splitter. The heavy half (resolver sources,
 * navigation, the artifact viewer) lives in ChatIdLinkProvider.tsx; this module must
 * not import it (the viewer imports chat-row-content, which imports this file).
 *
 * Without a provider the context is null: ids stay plain text (tests, read-only embeds).
 */
import { createContext, memo, useContext, useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { splitTextByChatIds, type ChatIdResolver, type ChatIdTarget } from './chat-id-links'

export interface ChatIdLinkApi {
    resolve: ChatIdResolver
    /** Real route for a target (so middle-click / "open in new tab" work); null for artifacts. */
    hrefOf: (target: ChatIdTarget) => string | null
    /** Primary action: navigate / open the viewer. `newWindow` pops an artifact out. */
    open: (target: ChatIdTarget, opts?: { newWindow?: boolean }) => void
}

export const ChatIdLinkContext = createContext<ChatIdLinkApi | null>(null)

export function useChatIdLinks(): ChatIdLinkApi | null {
    return useContext(ChatIdLinkContext)
}

const LINK_CLASS = 'cursor-pointer underline decoration-dotted decoration-accent-primary/70 underline-offset-2 hover:text-accent-primary'
const BARE_BUTTON = 'inline cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] text-left'

function isModified(e: ReactMouseEvent): boolean {
    return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0
}

/**
 * One id, rendered as a link when the host knows it. Tap/click = primary action. A tap is a
 * plain click: no touch/contextmenu handlers, so long-press stays free for text selection.
 */
export const ChatIdLink = memo(function ChatIdLink({ id, children }: { id: string; children: ReactNode }) {
    const api = useChatIdLinks()
    const { t } = useTranslation('common')
    const target = useMemo(() => api?.resolve(id) ?? null, [api, id])
    if (!api || !target) return <>{children}</>
    const title = t(`chat.idLink.${target.kind}`, { id })
    if (target.kind === 'artifact') {
        const popOut = t('chat.idLink.newWindow', { id })
        return (
            <span className="inline-flex items-baseline gap-0.5" data-chat-id-link="artifact">
                <button
                    type="button"
                    className={`${BARE_BUTTON} ${LINK_CLASS}`}
                    title={title}
                    onClick={e => api.open(target, { newWindow: e.ctrlKey || e.metaKey })}
                    onAuxClick={e => { if (e.button === 1) { e.preventDefault(); api.open(target, { newWindow: true }) } }}
                >
                    {children}
                </button>
                <button
                    type="button"
                    className={`${BARE_BUTTON} text-text-muted hover:text-accent-primary`}
                    title={popOut}
                    aria-label={popOut}
                    onClick={() => api.open(target, { newWindow: true })}
                >
                    ↗
                </button>
            </span>
        )
    }
    const href = api.hrefOf(target) ?? undefined
    return (
        <a
            href={href}
            className={LINK_CLASS}
            title={title}
            data-chat-id-link={target.kind}
            onClick={e => {
                if (isModified(e)) return // let the browser open the real route in a new tab/window
                e.preventDefault()
                api.open(target)
            }}
        >
            {children}
        </a>
    )
})

/** Plain (non-markdown) text with known ids linked. Stored text is untouched. */
export function ChatLinkedText({ text }: { text: string }) {
    const api = useChatIdLinks()
    const pieces = useMemo(() => (api ? splitTextByChatIds(text, api.resolve) : null), [api, text])
    if (!pieces) return <>{text}</>
    return (
        <>
            {pieces.map((p, i) => typeof p === 'string'
                ? <span key={i}>{p}</span>
                : <ChatIdLink key={i} id={p.id}>{p.id}</ChatIdLink>)}
        </>
    )
}
