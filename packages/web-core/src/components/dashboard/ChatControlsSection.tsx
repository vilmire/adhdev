import { useTranslation } from 'react-i18next'
import {
    describeModelSelection,
    isModelAxisSource,
    parseSessionLaunchRecord,
    type ModelAxisSource,
    type SessionLaunchRecord,
} from '@adhdev/mesh-shared'
import { useControlsBarVisibility } from '../../hooks/useControlsBarVisibility'
import ControlsBar, { type ControlsBarProps, getVisibleBarControls } from './ControlsBar'

/**
 * Phase E launch provenance as a session entry carries it: the full record over
 * P2P, or only `model` / `modelSource` from the server projection (a cloud
 * dashboard before P2P connects).
 */
export interface SessionLaunchSurface {
    launch?: SessionLaunchRecord
    model?: string
    modelSource?: ModelAxisSource
}

/** Read the launch fields off any session-entry-shaped object (DaemonData / SessionEntry). */
export function readSessionLaunchSurface(entry: unknown): SessionLaunchSurface {
    if (!entry || typeof entry !== 'object') return {}
    const record = entry as Record<string, unknown>
    const launch = parseSessionLaunchRecord(record.launch)
    return {
        ...(launch ? { launch } : {}),
        ...(typeof record.model === 'string' && record.model.trim() ? { model: record.model.trim() } : {}),
        ...(isModelAxisSource(record.modelSource) ? { modelSource: record.modelSource } : {}),
    }
}

const SOURCE_LABEL_DEFAULTS: Record<ModelAxisSource, string> = {
    user: 'chosen',
    remembered: 'remembered',
    mesh_slot: 'mesh slot',
    task_override: 'task',
    provider_default: 'default',
    unspecified: '',
}

type Translate = (key: string, options: Record<string, unknown>) => string

/** i18next-free fallback: the default value with `{{name}}` placeholders filled. */
function interpolateDefault(_key: string, options: Record<string, unknown>): string {
    return String(options.defaultValue ?? '').replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''))
}

/**
 * The chip text: "sonnet · chosen", "opus · default", "sonnet → opus (changed)".
 * Null when nothing is known about the model.
 */
export function formatSessionLaunchChip(
    surface: SessionLaunchSurface,
    t: Translate = interpolateDefault,
): { text: string; source: ModelAxisSource } | null {
    const described = surface.launch ? describeModelSelection(surface.launch.model) : undefined
    const value = described?.value ?? surface.model
    if (!value) return null
    const source: ModelAxisSource = described?.source ?? surface.modelSource ?? 'unspecified'
    if (described?.changedFrom) {
        return {
            text: t('chatControls.launchModelChanged', {
                from: described.changedFrom,
                to: value,
                defaultValue: '{{from}} → {{to}} (changed)',
            }),
            source,
        }
    }
    const label = SOURCE_LABEL_DEFAULTS[source]
        ? t(`chatControls.launchModelSource.${source}`, { defaultValue: SOURCE_LABEL_DEFAULTS[source] })
        : ''
    return { text: label ? `${value} · ${label}` : value, source }
}

export function SessionLaunchChip({ surface }: { surface: SessionLaunchSurface }) {
    const { t } = useTranslation('common')
    const chip = formatSessionLaunchChip(surface, t as unknown as Translate)
    if (!chip) return null
    return (
        <span
            className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-2xs text-text-muted"
            data-testid="session-launch-chip"
            data-model-source={chip.source}
        >
            {chip.text}
        </span>
    )
}

interface ChatControlsSectionProps extends ControlsBarProps {
    isActive?: boolean
    isCliTerminal?: boolean
    /** Phase E: the session's launch provenance, shown as a model chip. */
    launchSurface?: SessionLaunchSurface
}

export default function ChatControlsSection({
    isActive = true,
    isCliTerminal = false,
    routeId,
    sessionId,
    hostIdeType,
    providerType,
    displayLabel,
    controls,
    controlValues,
    currentStatus,
    coordinatorHint,
    launchSurface,
}: ChatControlsSectionProps) {
    const { isVisible } = useControlsBarVisibility()
    const visibleBarControls = getVisibleBarControls(controls, {
        hostIdeType,
        providerType,
        currentStatus,
    })
    const showBar = visibleBarControls.length > 0 && isVisible
    const showChip = !!launchSurface && !!formatSessionLaunchChip(launchSurface)

    if (!isActive || isCliTerminal || (!showBar && !showChip)) {
        return null
    }

    return (
        <div className="shrink-0 bg-[var(--surface-primary)] border-t border-border-subtle">
            {showChip && launchSurface && (
                <div className="flex justify-end px-3 pt-1">
                    <SessionLaunchChip surface={launchSurface} />
                </div>
            )}
            {showBar && (
                <ControlsBar
                    routeId={routeId}
                    sessionId={sessionId}
                    hostIdeType={hostIdeType}
                    providerType={providerType}
                    displayLabel={displayLabel}
                    controls={visibleBarControls}
                    controlValues={controlValues}
                    currentStatus={currentStatus}
                    coordinatorHint={coordinatorHint}
                />
            )}
        </div>
    )
}
