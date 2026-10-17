/**
 * OwnerAttentionNotice — a CLI session parked on a prompt only the OWNER may
 * answer (daemon-core OwnerAttentionMarker: grok's "Help improve Grok" consent
 * banner, a persistent workspace-trust prompt).
 *
 * Deliberately NON-ACTIONABLE: no approve / reject / option buttons. The daemon
 * forces activeModal and activeInteractivePrompt to null for this park so that
 * nothing can answer it automatically, and the dashboard must not offer a
 * one-tap answer either — the owner reads the real prompt in the terminal and
 * answers it there. The only affordance is navigation to the terminal view.
 *
 * Renders nothing once the park clears (`activeConv.ownerAttention` null).
 */
import { useTranslation } from 'react-i18next'
import type { ActiveConversation } from './types'
import { IconWarning } from '../Icons'

interface Props {
    activeConv: Pick<ActiveConversation, 'ownerAttention'>
    /** Switches this conversation to its terminal view; omitted where the surface cannot. */
    onOpenTerminal?: () => void
    /** True when the terminal view is already showing — the open affordance is hidden. */
    isTerminalView?: boolean
}

export default function OwnerAttentionNotice({ activeConv, onOpenTerminal, isTerminalView }: Props) {
    const { t } = useTranslation('common')
    const attention = activeConv.ownerAttention
    if (!attention) return null
    const message = attention.message?.trim()
    return (
        <div
            role="status"
            data-testid="owner-attention-notice"
            data-owner-attention-state={attention.stateId}
            className="text-white py-2.5 px-4 shrink-0 z-[5]"
            style={{ background: 'linear-gradient(135deg, var(--status-warning), color-mix(in srgb, var(--status-warning) 85%, #000))' }}
        >
            {message && (
                <div
                    className="text-2xs opacity-85 mb-1.5 line-clamp-3 max-w-full whitespace-pre-wrap break-words"
                    title={message}
                >
                    {message}
                </div>
            )}
            <div className="flex justify-between items-center gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="font-black text-xs flex items-center gap-2">
                        <IconWarning size={14} /> {t('approval.ownerAttentionTitle')}
                    </div>
                    <div className="text-2xs opacity-90">{t('approval.ownerAttentionBody')}</div>
                </div>
                {onOpenTerminal && !isTerminalView && (
                    <button
                        type="button"
                        onClick={onOpenTerminal}
                        className="btn btn-sm border-none rounded-md text-xs px-3 py-1 font-extrabold cursor-pointer whitespace-nowrap shrink-0"
                        style={{
                            color: 'var(--status-warning)',
                            background: 'var(--surface-primary)',
                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--status-warning) 18%, transparent)',
                        }}
                    >
                        {t('approval.ownerAttentionOpenTerminal')}
                    </button>
                )}
            </div>
        </div>
    )
}
