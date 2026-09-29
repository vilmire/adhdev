/**
 * BlueprintGraphNodes — the React Flow node renderers for the Blueprint graph
 * view (MeshBlueprintGraph): task cards, gate pills (diamond glyph), the
 * "N completed" fold chip, and the lane backdrop with its header controls.
 *
 * Colour vocabulary follows the list rows (MeshBlueprintRow ROW_DOT) so a
 * task reads the same colour on both views; every never-ending pulse is
 * `motion-safe:` gated.
 */
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { MeshGraphTheme } from './meshGraphTheme'
import { formatTaskCardTime } from './taskDagViewModel'
import { formatBlueprintAge } from './blueprintViewModel'
import {
    gateDeadlineReading,
    taskHeldUntilMs,
    taskNodeTimeReading,
    type BlueprintGraphFoldNode,
    type BlueprintGraphGateNode,
    type BlueprintGraphGateTone,
    type BlueprintGraphLane,
    type BlueprintGraphTaskNode,
    type BlueprintGraphTaskTone,
} from './blueprintGraphModel'
import { BLUEPRINT_GRAPH_SIZES } from './blueprintGraphLayout'

/**
 * Task tone → status dot + card border. Borders stay neutral except the two
 * failure tones, which get a thin semantic-red edge; the dot carries the rest.
 * Only a live running task pulses (motion-safe).
 */
export const TASK_TONE_STYLE: Record<BlueprintGraphTaskTone, { dot: string; pulse?: boolean; border: string }> = {
    pending: { dot: 'bg-text-muted', border: 'border-border-default' },
    running: { dot: 'bg-accent', pulse: true, border: 'border-border-default' },
    completed: { dot: 'bg-status-online', border: 'border-border-subtle' },
    failed: { dot: 'bg-status-error', border: 'border-status-error/40' },
    cancelled: { dot: 'bg-status-offline', border: 'border-border-subtle' },
    dead: { dot: 'bg-status-error', border: 'border-status-error/50' },
    plan: { dot: 'bg-text-muted', border: 'border-border-default' },
}

/**
 * Gate tone → dot + pill shell. The shell is always the neutral card surface;
 * attention (awaiting) and failure (expired) colour only the thin border and
 * the dot. Pulses only on the live-waiting states (awaiting / claimed).
 */
export const GATE_TONE_STYLE: Record<BlueprintGraphGateTone, { dot: string; pulse?: boolean; shell: string }> = {
    declared: { dot: 'bg-text-muted', shell: 'border-dashed border-border-default text-text-secondary' },
    awaiting: { dot: 'bg-status-warning', pulse: true, shell: 'border-status-warning/45 text-text-primary' },
    claimed: { dot: 'bg-accent', pulse: true, shell: 'border-border-default text-text-primary' },
    expired: { dot: 'bg-status-error', shell: 'border-status-error/45 text-text-primary' },
    released: { dot: 'bg-status-online', shell: 'border-border-subtle text-text-secondary' },
    abandoned: { dot: 'bg-status-offline', shell: 'border-border-subtle text-text-muted' },
}

const HANDLE_CLASS = '!h-1.5 !w-1.5 !border-0 !bg-transparent'

export interface TaskNodeData extends Record<string, unknown> {
    node: BlueprintGraphTaskNode
    theme: MeshGraphTheme
    nowMs: number
    /** `checkout · machine` for the node the task ran on, when known. */
    nodeLabel?: string
    tooltip: string
}
export interface GateNodeData extends Record<string, unknown> {
    node: BlueprintGraphGateNode
    theme: MeshGraphTheme
    nowMs: number
    selected: boolean
    tooltip: string
}
export interface FoldNodeData extends Record<string, unknown> {
    node: BlueprintGraphFoldNode
    theme: MeshGraphTheme
}
export interface LaneNodeData extends Record<string, unknown> {
    lane: BlueprintGraphLane
    theme: MeshGraphTheme
    title: string
    titleTooltip?: string
    width: number
    height: number
    onOpen?: () => void
    onToggleCollapsed: () => void
    onToggleFolded: () => void
}

export type BlueprintTaskFlowNode = Node<TaskNodeData, 'bpTask'>
export type BlueprintGateFlowNode = Node<GateNodeData, 'bpGate'>
export type BlueprintFoldFlowNode = Node<FoldNodeData, 'bpFold'>
export type BlueprintLaneFlowNode = Node<LaneNodeData, 'bpLane'>
export type BlueprintFlowNode = BlueprintTaskFlowNode | BlueprintGateFlowNode | BlueprintFoldFlowNode | BlueprintLaneFlowNode

/** Local date-time for a hold; the year appears only when it is not this year. */
function formatHoldTime(atMs: number, nowMs: number): string {
    const at = new Date(atMs)
    const sameYear = at.getFullYear() === new Date(nowMs).getFullYear()
    return at.toLocaleString(undefined, { ...(sameYear ? {} : { year: 'numeric' }), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function TaskNodeCard({ data }: NodeProps<BlueprintTaskFlowNode>) {
    const { t } = useTranslation('common')
    const { node, nowMs, nodeLabel, tooltip } = data
    const tone = TASK_TONE_STYLE[node.tone]
    const reading = taskNodeTimeReading(node, nowMs)
    const finished = reading?.kind === 'finished' ? formatTaskCardTime(reading.at, nowMs, t) : undefined
    const timeText = !reading
        ? ''
        : reading.kind === 'running'
            ? t('mesh.blueprint.graph.timeRunning', { age: formatBlueprintAge(reading.elapsedMs) })
            : reading.kind === 'finished'
                ? t('mesh.blueprint.graph.timeFinished', { time: finished ? `${finished.absolute} (${finished.relative})` : '—' })
                : t('mesh.blueprint.graph.timeQueued', { age: formatBlueprintAge(reading.elapsedMs) })
    // A future not_before hold reads "held until <local time>", not "pending".
    const heldUntil = taskHeldUntilMs(node, nowMs)
    const heldText = heldUntil != null
        ? t('mesh.blueprint.graph.heldUntil', { time: formatHoldTime(heldUntil, nowMs) })
        : ''
    const statusWord = node.generating
        ? t('mesh.blueprint.list.generating')
        : heldUntil != null ? t('mesh.blueprint.graph.tone.held') : t(`mesh.blueprint.graph.tone.${node.tone}`)
    const muted = node.tone === 'completed' || node.tone === 'cancelled'
    const statusTone = node.tone === 'dead' || node.tone === 'failed'
        ? 'text-status-error'
        : node.tone === 'running'
            ? 'text-accent'
            : 'text-text-muted'
    return (
        <div
            data-testid="bp-graph-task"
            data-tone={node.tone}
            title={tooltip}
            className={`flex cursor-pointer flex-col justify-between rounded-lg border bg-surface-primary px-2.5 py-1.5 text-text-primary transition-colors hover:border-border-accent ${tone.border} ${node.tone === 'plan' ? 'border-dashed' : ''} ${muted ? 'opacity-70' : ''}`}
            style={{ width: BLUEPRINT_GRAPH_SIZES.task.width, height: BLUEPRINT_GRAPH_SIZES.task.height }}
        >
            <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
            <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
            <div className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot} ${tone.pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
                <span className={`shrink-0 text-4xs font-medium ${statusTone}`}>{statusWord}</span>
                {(heldText || timeText) && <span data-testid={heldText ? 'bp-graph-held-until' : undefined} title={heldText ? node.notBefore : undefined} className="ml-auto min-w-0 truncate font-mono text-4xs tabular-nums text-text-muted">{heldText || timeText}</span>}
            </div>
            <div className="truncate text-3xs font-medium leading-4">{node.title}</div>
            <div className="flex min-w-0 items-center gap-1 text-4xs text-text-muted">
                {node.provider && <span className="shrink-0 font-medium">{node.provider}</span>}
                {nodeLabel && <span className="min-w-0 truncate">{node.provider ? '@ ' : ''}{nodeLabel}</span>}
                {!node.provider && !nodeLabel && node.ref && <span className="min-w-0 truncate opacity-80">{node.ref}</span>}
            </div>
        </div>
    )
}

function GateNodePill({ data }: NodeProps<BlueprintGateFlowNode>) {
    const { t } = useTranslation('common')
    const { node, nowMs, selected, tooltip } = data
    const tone = GATE_TONE_STYLE[node.tone]
    const deadline = gateDeadlineReading(node, nowMs)
    return (
        <div
            data-testid="bp-graph-gate"
            data-tone={node.tone}
            title={tooltip}
            className={`flex cursor-pointer items-center gap-2 rounded-full border bg-surface-primary px-3 transition-colors hover:border-border-accent ${tone.shell} ${selected ? 'ring-1 ring-accent/60' : ''}`}
            style={{ width: BLUEPRINT_GRAPH_SIZES.gate.width, height: BLUEPRINT_GRAPH_SIZES.gate.height }}
        >
            <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
            <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
            {/* The diamond: the gate's shape cue, independent of colour. */}
            <span className="relative flex h-3.5 w-3.5 shrink-0 rotate-45 items-center justify-center rounded-[3px] border border-text-muted" aria-hidden>
                <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${tone.pulse ? 'motion-safe:animate-pulse' : ''}`} />
            </span>
            <span className="flex min-w-0 flex-col">
                <span className={`truncate text-4xs font-medium ${node.tone === 'expired' ? 'text-status-error' : node.tone === 'awaiting' ? 'text-status-warning' : 'text-text-muted'}`}>
                    {t(`mesh.blueprint.graph.gateTone.${node.tone}`)}
                </span>
                <span className="truncate text-3xs font-medium leading-4">{node.ref}</span>
                {deadline && (
                    <span className={`truncate font-mono text-4xs tabular-nums ${deadline.overdue ? 'text-status-error' : 'text-text-muted'}`}>
                        {deadline.overdue
                            ? t('mesh.blueprint.graph.deadlineOverdue', { age: formatBlueprintAge(deadline.ms) })
                            : t('mesh.blueprint.graph.deadlineIn', { age: formatBlueprintAge(deadline.ms) })}
                    </span>
                )}
            </span>
        </div>
    )
}

function FoldNodeChip({ data }: NodeProps<BlueprintFoldFlowNode>) {
    const { t } = useTranslation('common')
    const { node } = data
    return (
        <div
            data-testid="bp-graph-fold"
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-default bg-surface-primary text-3xs font-medium text-text-secondary"
            style={{ width: BLUEPRINT_GRAPH_SIZES.fold.width, height: BLUEPRINT_GRAPH_SIZES.fold.height }}
            title={node.memberIds.map(id => id.replace(/^task:/, '')).join('\n')}
        >
            <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
            <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
            <span className="text-status-online" aria-hidden>✓</span>
            {t('mesh.blueprint.graph.foldNode', { count: node.count })}
        </div>
    )
}

function laneToggleClass(): string {
    return 'nodrag nopan pointer-events-auto inline-flex h-5 shrink-0 items-center rounded-md border border-border-default bg-transparent px-1.5 text-4xs font-medium leading-none text-text-secondary transition-colors hover:bg-bg-glass-hover hover:text-text-primary'
}

function LaneBackdrop({ data }: NodeProps<BlueprintLaneFlowNode>) {
    const { t } = useTranslation('common')
    const { lane, title, titleTooltip, width, height, onOpen, onToggleCollapsed, onToggleFolded } = data
    const counts = lane.group.counts
    const chips: Array<{ key: string; text: string; tone: string }> = []
    if (counts.running) chips.push({ key: 'r', text: t('mesh.blueprint.graph.countRunning', { count: counts.running }), tone: 'text-accent' })
    if (counts.gatesBlocking) chips.push({ key: 'g', text: t('mesh.blueprint.graph.countGates', { count: counts.gatesBlocking }), tone: 'text-status-warning' })
    if (counts.dead) chips.push({ key: 'd', text: t('mesh.blueprint.graph.countDead', { count: counts.dead }), tone: 'text-status-error' })
    if (counts.pending) chips.push({ key: 'p', text: t('mesh.blueprint.graph.countWaiting', { count: counts.pending }), tone: '' })
    if (counts.failed) chips.push({ key: 'f', text: t('mesh.blueprint.graph.countFailed', { count: counts.failed }), tone: 'text-status-error' })
    if (counts.completed) chips.push({ key: 'c', text: t('mesh.blueprint.graph.countDone', { count: counts.completed }), tone: 'text-text-muted' })
    return (
        <div
            data-testid="bp-graph-lane"
            className={`rounded-xl border border-border-subtle bg-bg-glass ${lane.group.live ? '' : 'opacity-75'}`}
            style={{ width, height }}
        >
            <div className="flex h-[34px] min-w-0 items-center gap-2 px-3">
                <button
                    type="button"
                    onClick={event => { event.stopPropagation(); onOpen?.() }}
                    disabled={!onOpen}
                    title={titleTooltip}
                    className={`nodrag nopan pointer-events-auto min-w-0 truncate text-left text-3xs font-semibold text-text-primary ${onOpen ? 'hover:text-accent hover:underline' : 'cursor-default'}`}
                >
                    {title}
                </button>
                <span className="flex min-w-0 shrink items-center gap-1.5 truncate text-4xs text-text-muted">
                    {chips.map(chip => <span key={chip.key} className={`shrink-0 ${chip.tone}`}>{chip.text}</span>)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                    {lane.canFold && !lane.collapsed && (
                        <button type="button" className={laneToggleClass()} aria-pressed={lane.folded} onClick={event => { event.stopPropagation(); onToggleFolded() }}>
                            {lane.folded ? t('mesh.blueprint.graph.unfoldCompleted') : t('mesh.blueprint.graph.foldCompleted')}
                        </button>
                    )}
                    <button type="button" className={laneToggleClass()} aria-expanded={!lane.collapsed} onClick={event => { event.stopPropagation(); onToggleCollapsed() }}>
                        {lane.collapsed ? `${t('mesh.blueprint.graph.laneExpand')} ▼` : `${t('mesh.blueprint.graph.laneCollapse')} ▲`}
                    </button>
                </span>
            </div>
        </div>
    )
}

export const blueprintGraphNodeTypes = {
    bpTask: memo(TaskNodeCard),
    bpGate: memo(GateNodePill),
    bpFold: memo(FoldNodeChip),
    bpLane: memo(LaneBackdrop),
}
