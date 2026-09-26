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

export const TASK_TONE_STYLE: Record<BlueprintGraphTaskTone, { dot: string; pulse?: boolean; border: { dark: string; light: string } }> = {
    pending: { dot: 'bg-slate-400', border: { dark: 'border-white/12', light: 'border-slate-300' } },
    running: { dot: 'bg-sky-400', pulse: true, border: { dark: 'border-sky-400/60', light: 'border-sky-400' } },
    completed: { dot: 'bg-emerald-400', border: { dark: 'border-emerald-400/35', light: 'border-emerald-300' } },
    failed: { dot: 'bg-rose-400', border: { dark: 'border-rose-400/60', light: 'border-rose-400' } },
    cancelled: { dot: 'bg-slate-500', border: { dark: 'border-slate-500/40', light: 'border-slate-300' } },
    dead: { dot: 'bg-red-500', border: { dark: 'border-red-500/70', light: 'border-red-500' } },
    plan: { dot: 'bg-slate-400', border: { dark: 'border-slate-400/35', light: 'border-slate-300' } },
}

export const GATE_TONE_STYLE: Record<BlueprintGraphGateTone, { dot: string; pulse?: boolean; shell: { dark: string; light: string } }> = {
    declared: { dot: 'bg-slate-400', shell: { dark: 'border-dashed border-slate-400/40 bg-slate-500/10 text-slate-200', light: 'border-dashed border-slate-300 bg-slate-50 text-slate-700' } },
    awaiting: { dot: 'bg-amber-400', pulse: true, shell: { dark: 'border-amber-400/70 bg-amber-500/15 text-amber-100', light: 'border-amber-400 bg-amber-50 text-amber-800' } },
    claimed: { dot: 'bg-sky-400', pulse: true, shell: { dark: 'border-sky-400/60 bg-sky-500/15 text-sky-100', light: 'border-sky-400 bg-sky-50 text-sky-800' } },
    expired: { dot: 'bg-rose-400', pulse: true, shell: { dark: 'border-rose-400/70 bg-rose-500/15 text-rose-100', light: 'border-rose-400 bg-rose-50 text-rose-800' } },
    released: { dot: 'bg-emerald-400', shell: { dark: 'border-emerald-400/35 bg-emerald-500/10 text-emerald-100', light: 'border-emerald-300 bg-emerald-50 text-emerald-800' } },
    abandoned: { dot: 'bg-slate-500', shell: { dark: 'border-slate-500/40 bg-white/[0.03] text-slate-300', light: 'border-slate-300 bg-slate-100 text-slate-600' } },
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
    const { node, theme, nowMs, nodeLabel, tooltip } = data
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
        ? (theme.isDark ? 'text-red-300' : 'text-red-700')
        : node.tone === 'running'
            ? (theme.isDark ? 'text-sky-300' : 'text-sky-700')
            : ''
    return (
        <div
            data-testid="bp-graph-task"
            data-tone={node.tone}
            title={tooltip}
            className={`flex cursor-pointer flex-col justify-between rounded-xl border px-2.5 py-1.5 shadow-sm ${theme.isDark ? `${tone.border.dark} bg-slate-900/90 text-slate-200` : `${tone.border.light} bg-white text-slate-700`} ${node.tone === 'plan' ? 'border-dashed' : ''} ${muted ? 'opacity-70' : ''}`}
            style={{ width: BLUEPRINT_GRAPH_SIZES.task.width, height: BLUEPRINT_GRAPH_SIZES.task.height }}
        >
            <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
            <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
            <div className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot} ${tone.pulse ? 'motion-safe:animate-pulse' : ''}`} aria-hidden />
                <span className={`shrink-0 text-4xs font-semibold uppercase tracking-wide ${statusTone || 'opacity-75'}`}>{statusWord}</span>
                {(heldText || timeText) && <span data-testid={heldText ? 'bp-graph-held-until' : undefined} title={heldText ? node.notBefore : undefined} className={`ml-auto min-w-0 truncate font-mono text-4xs tabular-nums ${theme.isDark ? 'text-slate-400' : 'text-slate-500'}`}>{heldText || timeText}</span>}
            </div>
            <div className="truncate text-3xs font-medium leading-4">{node.title}</div>
            <div className={`flex min-w-0 items-center gap-1 text-4xs ${theme.isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {node.provider && <span className="shrink-0 font-medium">{node.provider}</span>}
                {nodeLabel && <span className="min-w-0 truncate">{node.provider ? '@ ' : ''}{nodeLabel}</span>}
                {!node.provider && !nodeLabel && node.ref && <span className="min-w-0 truncate opacity-80">{node.ref}</span>}
            </div>
        </div>
    )
}

function GateNodePill({ data }: NodeProps<BlueprintGateFlowNode>) {
    const { t } = useTranslation('common')
    const { node, theme, nowMs, selected, tooltip } = data
    const tone = GATE_TONE_STYLE[node.tone]
    const deadline = gateDeadlineReading(node, nowMs)
    return (
        <div
            data-testid="bp-graph-gate"
            data-tone={node.tone}
            title={tooltip}
            className={`flex cursor-pointer items-center gap-2 rounded-full border-2 px-3 shadow-sm ${theme.isDark ? tone.shell.dark : tone.shell.light} ${selected ? (theme.isDark ? 'ring-2 ring-white/40' : 'ring-2 ring-slate-500/40') : ''}`}
            style={{ width: BLUEPRINT_GRAPH_SIZES.gate.width, height: BLUEPRINT_GRAPH_SIZES.gate.height }}
        >
            <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
            <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
            {/* The diamond: the gate's shape cue, independent of colour. */}
            <span className={`relative flex h-4 w-4 shrink-0 rotate-45 items-center justify-center rounded-[3px] border border-current`} aria-hidden>
                <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${tone.pulse ? 'motion-safe:animate-pulse' : ''}`} />
            </span>
            <span className="flex min-w-0 flex-col">
                <span className="truncate text-4xs font-semibold uppercase tracking-wide opacity-85">
                    {t(`mesh.blueprint.graph.gateTone.${node.tone}`)}
                </span>
                <span className="truncate text-3xs font-medium leading-4">{node.ref}</span>
                {deadline && (
                    <span className={`truncate font-mono text-4xs tabular-nums ${deadline.overdue ? (theme.isDark ? 'text-rose-300' : 'text-rose-700') : 'opacity-75'}`}>
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
    const { node, theme } = data
    return (
        <div
            data-testid="bp-graph-fold"
            className={`flex items-center justify-center gap-1.5 rounded-lg border border-dashed text-3xs font-medium ${theme.isDark ? 'border-emerald-400/35 bg-emerald-500/[0.07] text-emerald-200' : 'border-emerald-300 bg-emerald-50/80 text-emerald-700'}`}
            style={{ width: BLUEPRINT_GRAPH_SIZES.fold.width, height: BLUEPRINT_GRAPH_SIZES.fold.height }}
            title={node.memberIds.map(id => id.replace(/^task:/, '')).join('\n')}
        >
            <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
            <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
            <span aria-hidden>✓</span>
            {t('mesh.blueprint.graph.foldNode', { count: node.count })}
        </div>
    )
}

function laneToggleClass(isDark: boolean): string {
    return `nodrag nopan pointer-events-auto shrink-0 rounded-md border px-1.5 py-0.5 text-4xs font-medium transition-colors ${isDark
        ? 'border-white/10 bg-slate-950/70 text-slate-300 hover:bg-slate-900'
        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`
}

function LaneBackdrop({ data }: NodeProps<BlueprintLaneFlowNode>) {
    const { t } = useTranslation('common')
    const { lane, theme, title, titleTooltip, width, height, onOpen, onToggleCollapsed, onToggleFolded } = data
    const counts = lane.group.counts
    const chips: Array<{ key: string; text: string; tone: string }> = []
    if (counts.running) chips.push({ key: 'r', text: t('mesh.blueprint.graph.countRunning', { count: counts.running }), tone: theme.isDark ? 'text-sky-300' : 'text-sky-700' })
    if (counts.gatesBlocking) chips.push({ key: 'g', text: t('mesh.blueprint.graph.countGates', { count: counts.gatesBlocking }), tone: theme.isDark ? 'text-amber-300' : 'text-amber-700' })
    if (counts.dead) chips.push({ key: 'd', text: t('mesh.blueprint.graph.countDead', { count: counts.dead }), tone: theme.isDark ? 'text-red-300' : 'text-red-700' })
    if (counts.pending) chips.push({ key: 'p', text: t('mesh.blueprint.graph.countWaiting', { count: counts.pending }), tone: '' })
    if (counts.failed) chips.push({ key: 'f', text: t('mesh.blueprint.graph.countFailed', { count: counts.failed }), tone: theme.isDark ? 'text-rose-300' : 'text-rose-700' })
    if (counts.completed) chips.push({ key: 'c', text: t('mesh.blueprint.graph.countDone', { count: counts.completed }), tone: theme.isDark ? 'text-emerald-300' : 'text-emerald-700' })
    return (
        <div
            data-testid="bp-graph-lane"
            className={`rounded-2xl border ${theme.isDark ? 'border-sky-300/15 bg-sky-400/[0.035]' : 'border-sky-200 bg-white/45'} ${lane.group.live ? '' : 'opacity-75'}`}
            style={{ width, height }}
        >
            <div className="flex h-[34px] min-w-0 items-center gap-2 px-3">
                <button
                    type="button"
                    onClick={event => { event.stopPropagation(); onOpen?.() }}
                    disabled={!onOpen}
                    title={titleTooltip}
                    className={`nodrag nopan pointer-events-auto min-w-0 truncate text-left text-3xs font-semibold ${theme.isDark ? 'text-indigo-300' : 'text-indigo-700'} ${onOpen ? 'hover:underline' : 'cursor-default'}`}
                >
                    {title}
                </button>
                <span className="flex min-w-0 shrink items-center gap-1.5 truncate text-4xs opacity-90">
                    {chips.map(chip => <span key={chip.key} className={`shrink-0 ${chip.tone}`}>{chip.text}</span>)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                    {lane.canFold && !lane.collapsed && (
                        <button type="button" className={laneToggleClass(theme.isDark)} aria-pressed={lane.folded} onClick={event => { event.stopPropagation(); onToggleFolded() }}>
                            {lane.folded ? t('mesh.blueprint.graph.unfoldCompleted') : t('mesh.blueprint.graph.foldCompleted')}
                        </button>
                    )}
                    <button type="button" className={laneToggleClass(theme.isDark)} aria-expanded={!lane.collapsed} onClick={event => { event.stopPropagation(); onToggleCollapsed() }}>
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
