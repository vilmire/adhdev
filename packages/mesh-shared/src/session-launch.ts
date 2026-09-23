/**
 * session-launch — how a session was launched: provider, model and thinking
 * level, and WHERE each value came from.
 *
 * Wiring-unification Phase E (docs/design/2026-09-23-wiring-unification.md §7,
 * RC5). Before this record the only trace of a session's model was a display
 * string in recent-activity (`buildLegacyModelModeSummaryMetadata`), so nobody
 * could answer "did I pick this model, did the dashboard restore it from last
 * time, did a mesh slot choose it, or is it just the provider default?" — and
 * after a daemon restart not even the value survived.
 *
 * The daemon owns the record (daemon-core `SessionRegistry`); this file holds the
 * shape and the pure readers so daemon-core, web-core, the server and the MCP
 * server all read one definition. It is a dependency-free leaf, like the rest of
 * mesh-shared.
 *
 * ★Server content boundary (CLAUDE.md): the full record rides P2P only. The
 * server path carries exactly two derived fields — `model` (an identifier,
 * passed through {@link sanitizeModelIdentifier}) and `modelSource` (an enum,
 * passed through {@link isModelAxisSource}). Never widen that to the record.
 */

/**
 * Where a model / thinking-level value came from.
 *
 * `restore` is deliberately NOT a member: a hosted session re-attached after a
 * daemon restart keeps the ORIGINAL source (the user still picked that model);
 * only `SessionLaunchRecord.launchedBy` records that the session came back via
 * restore.
 */
export const MODEL_AXIS_SOURCES = [
    /** Picked explicitly for this launch (dashboard dropdown, coordinator dialog). */
    'user',
    /** The dashboard dialog restored it from the last launch (browser-local memory). */
    'remembered',
    /** A mesh capability slot supplied it (or a difficulty preset the slot outranked). */
    'mesh_slot',
    /** An explicit per-task model / thinking level on a mesh queue task. */
    'task_override',
    /** Nothing was requested; the provider's default is known (discovery / manifest). */
    'provider_default',
    /** A value was requested without saying where it came from, or nothing is known. */
    'unspecified',
] as const

export type ModelAxisSource = typeof MODEL_AXIS_SOURCES[number]

export function isModelAxisSource(value: unknown): value is ModelAxisSource {
    return typeof value === 'string' && (MODEL_AXIS_SOURCES as readonly string[]).includes(value)
}

/**
 * Which surface started the session. `restore` means "re-attached to a hosted
 * runtime that outlived a daemon restart" — the axis sources are preserved.
 */
export const SESSION_LAUNCHED_BY = ['dashboard', 'mesh', 'cli', 'api', 'restore'] as const

export type SessionLaunchedBy = typeof SESSION_LAUNCHED_BY[number]

export function isSessionLaunchedBy(value: unknown): value is SessionLaunchedBy {
    return typeof value === 'string' && (SESSION_LAUNCHED_BY as readonly string[]).includes(value)
}

/** How a value entered the axis history. */
export type ModelSelectionVia = 'launch' | 'change_model' | 'observed'

export interface ModelSelectionHistoryEntry {
    at: number
    value: string
    via: ModelSelectionVia
}

/** One axis (model, or thinking level) of a session launch. */
export interface ModelSelection {
    /** What the caller asked for. Absent = nothing requested. */
    requested?: string
    source: ModelAxisSource
    /**
     * The value actually handed to the provider: after `modelLaunchValueMap`
     * (CLI `--model` template) or the ACP `setConfigOption` call. Absent when the
     * request was not applied (no template, the config call failed) or nothing
     * was requested.
     */
    launchValue?: string
    /**
     * The provider default this session is expected to run with when nothing was
     * requested (`source === 'provider_default'` only): discovery `models[0]`,
     * else the manifest's first option. Nothing was passed to the provider.
     */
    resolvedDefault?: string
    /** Last explicit runtime change (`change_model` / `set_thought_level`). */
    current?: string
    /** Last value the provider itself reported (statusline, native history). */
    observed?: string
    observedAt?: number
    /** Every value change in order. The last entry is the value in force. */
    history: ModelSelectionHistoryEntry[]
}

export interface SessionLaunchRecord {
    sessionId: string
    providerType: string
    providerVersion?: string
    providerChannel?: 'stable' | 'preview'
    /** `restore` = re-attached after a daemon restart; the axis sources stay the original ones. */
    launchedBy: SessionLaunchedBy
    launchedAt: number
    workspace?: string
    model: ModelSelection
    thinkingLevel: ModelSelection
    autoApproveModeId?: string
    /**
     * Reserved by the design (§7 E1) for sanitized launch argv. Not populated:
     * argv carries coordinator system-prompt text and config paths, and the
     * session-host record already keeps the raw argv for restore.
     */
    cliArgs?: string[]
}

/** History is bounded; the first `launch` entry is always kept. */
export const MODEL_SELECTION_HISTORY_LIMIT = 20

/** The value in force now: the latest change, else the launch-time value. */
export function effectiveModelSelectionValue(selection: ModelSelection | null | undefined): string | undefined {
    if (!selection) return undefined
    const last = Array.isArray(selection.history) ? selection.history[selection.history.length - 1] : undefined
    return last?.value
        ?? selection.current
        ?? selection.observed
        ?? launchModelSelectionValue(selection)
}

/** The value the session started with (what was passed, else asked for, else the default). */
export function launchModelSelectionValue(selection: ModelSelection | null | undefined): string | undefined {
    if (!selection) return undefined
    const launch = Array.isArray(selection.history)
        ? selection.history.find((entry) => entry.via === 'launch')
        : undefined
    return launch?.value ?? selection.launchValue ?? selection.requested ?? selection.resolvedDefault
}

export interface ModelSelectionDisplay {
    /** The value in force now. */
    value: string
    /** The value the session launched with, when it differs from `value`. */
    changedFrom?: string
    source: ModelAxisSource
}

/** Pure projection for UI chips: "sonnet · chosen", "sonnet → opus (changed)". */
export function describeModelSelection(selection: ModelSelection | null | undefined): ModelSelectionDisplay | undefined {
    const value = effectiveModelSelectionValue(selection)
    if (!selection || !value) return undefined
    const launched = launchModelSelectionValue(selection)
    return {
        value,
        ...(launched && launched !== value ? { changedFrom: launched } : {}),
        source: isModelAxisSource(selection.source) ? selection.source : 'unspecified',
    }
}

/**
 * The only form a model / thinking value may take on the server path: an
 * identifier (`claude-opus-4-1`, `gpt-5.6-sol`, `openai/gpt-4o`, `opus[1m]`,
 * `high`). No whitespace, bounded length — a free-text sentence cannot pass.
 * Human labels (`Gemini 3.7 Flash (High)`) are P2P-only and are dropped here.
 */
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,95}$/

export function sanitizeModelIdentifier(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return MODEL_IDENTIFIER_PATTERN.test(trimmed) ? trimmed : undefined
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseModelSelection(raw: unknown): ModelSelection | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const record = raw as Record<string, unknown>
    const history: ModelSelectionHistoryEntry[] = []
    if (Array.isArray(record.history)) {
        for (const entry of record.history) {
            if (!entry || typeof entry !== 'object') continue
            const e = entry as Record<string, unknown>
            const value = readString(e.value)
            const at = readFiniteNumber(e.at)
            const via = e.via === 'launch' || e.via === 'change_model' || e.via === 'observed' ? e.via : undefined
            if (value && at !== undefined && via) history.push({ at, value, via })
        }
    }
    const requested = readString(record.requested)
    const launchValue = readString(record.launchValue)
    const resolvedDefault = readString(record.resolvedDefault)
    const current = readString(record.current)
    const observed = readString(record.observed)
    const observedAt = readFiniteNumber(record.observedAt)
    return {
        source: isModelAxisSource(record.source) ? record.source : 'unspecified',
        ...(requested ? { requested } : {}),
        ...(launchValue ? { launchValue } : {}),
        ...(resolvedDefault ? { resolvedDefault } : {}),
        ...(current ? { current } : {}),
        ...(observed ? { observed } : {}),
        ...(observedAt !== undefined ? { observedAt } : {}),
        history: history.slice(-MODEL_SELECTION_HISTORY_LIMIT),
    }
}

/**
 * Validate a record that crossed a process or storage boundary (session-host
 * record meta on restore, a P2P snapshot). Returns undefined for anything that
 * is not recognisably a launch record; unknown keys are dropped.
 */
export function parseSessionLaunchRecord(raw: unknown): SessionLaunchRecord | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const record = raw as Record<string, unknown>
    const sessionId = readString(record.sessionId)
    const providerType = readString(record.providerType)
    const launchedAt = readFiniteNumber(record.launchedAt)
    const model = parseModelSelection(record.model)
    const thinkingLevel = parseModelSelection(record.thinkingLevel)
    if (!sessionId || !providerType || launchedAt === undefined || !model || !thinkingLevel) return undefined
    const providerVersion = readString(record.providerVersion)
    const workspace = readString(record.workspace)
    const autoApproveModeId = readString(record.autoApproveModeId)
    return {
        sessionId,
        providerType,
        ...(providerVersion ? { providerVersion } : {}),
        ...(record.providerChannel === 'stable' || record.providerChannel === 'preview'
            ? { providerChannel: record.providerChannel }
            : {}),
        launchedBy: isSessionLaunchedBy(record.launchedBy) ? record.launchedBy : 'api',
        launchedAt,
        ...(workspace ? { workspace } : {}),
        model,
        thinkingLevel,
        ...(autoApproveModeId ? { autoApproveModeId } : {}),
    }
}
