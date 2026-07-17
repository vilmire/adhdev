import type { TFunction } from 'i18next'

export function getNewSessionLabel(t: TFunction): string {
    return t('paneGroup.newSession')
}

export function getNewSessionDescription(t: TFunction): string {
    return t('paneGroup.newSessionDescription')
}

/** @deprecated Use getNewSessionLabel(t) with useTranslation */
export const DASHBOARD_NEW_SESSION_LABEL = 'New session'

/** @deprecated Use getNewSessionDescription(t) with useTranslation */
export const DASHBOARD_NEW_SESSION_DESCRIPTION =
    'A connected machine is ready. Start a new session with any installed provider — CLI, ACP, or IDE.'
