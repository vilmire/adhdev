/**
 * ChatActivitySection — Settings toggle for chat activity rows (tool calls,
 * terminal output, thinking). Writes the same global preference the in-pane
 * Activity pill flips (chat-activity-visibility.ts); mounted ChatPanes react
 * immediately via the preference's custom change event.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ToggleRow } from './ToggleRow'
import { IconWrench } from '../Icons'
import {
    readChatActivityVisiblePreference,
    setChatActivityVisiblePreference,
    subscribeChatActivityVisiblePreference,
} from '../dashboard/chat-activity-visibility'

export function ChatActivitySection() {
    const { t } = useTranslation('common')
    const [visible, setVisible] = useState(() => readChatActivityVisiblePreference())

    // Stay in sync when the in-pane pill (or another tab) flips the preference.
    useEffect(() => subscribeChatActivityVisiblePreference(setVisible), [])

    return (
        <ToggleRow
            label={<span className="flex items-center gap-1.5"><IconWrench size={15} /> {t('settings.chatActivity.rowLabel')}</span>}
            description={visible ? t('settings.chatActivity.descriptionOn') : t('settings.chatActivity.descriptionOff')}
            checked={visible}
            onChange={(checked) => {
                setVisible(checked)
                setChatActivityVisiblePreference(checked)
            }}
        />
    )
}
