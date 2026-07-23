/**
 * Spec Debug snapshot normalization.
 *
 * The daemon's `get_spec_debug` returns whatever the session adapter's
 * `getDebugSnapshot()` produces, and that shape differs by adapter:
 *
 *  - SpecCliAdapter (v4 FSM / spec-driven providers): the rich "panel shape"
 *    with `spec_id`, `current_state`, `stateHistory`, `sections`, `screen`,
 *    `specPath`, `current_modal`, … — every field the panel renders.
 *
 *  - ProviderCliAdapter (v1 `provider.v1.json` / native-source providers such
 *    as kimi): a diagnostics shape with `cliType`, `currentStatus`,
 *    `activeModal: { message, buttons: string[] }`, `terminal.screenText`,
 *    `parser.parsedStatusCache`, `messageCounts`, … and NONE of the spec
 *    state-machine fields (there is no idle/busy regex FSM to report).
 *
 * The panel was written against the first shape only, so for a native-source
 * provider it received a non-null snapshot (isSpecProvider stayed true) whose
 * every rendered field was `undefined` — the body looked empty and the
 * `spec_id` chip was blank. This module maps EITHER shape into the panel's
 * `SpecSnapshot`, filling whatever is available and flagging the parts that
 * genuinely depend on a state-machine spec so the panel can render them as
 * "N/A (native-source provider)" instead of silently dropping the snapshot.
 *
 * Discriminator: presence of state-machine rule fields (`spec_id`,
 * `current_state`, or a `stateHistory` array) — NOT a hard-coded `kimi`
 * branch — so any future native-source provider is handled the same way.
 */

/** Structural mirror of SpecDebugPanel's SpecSnapshot (kept in sync locally to
 *  avoid a circular import with the component). */
export interface NormalizedSpecSnapshot {
    cliType: string
    spec_id: string
    specPath?: string
    current_state: { id: string; label: string; title: string | null } | null
    current_modal: { title: string | null; buttons: { index: number; label: string }[] } | null
    activeInteractivePrompt: unknown
    exited: boolean
    screen: string
    sections: Record<string, string> | undefined
    stateHistory: Array<Record<string, unknown>>
    idleHoldPending: boolean
    lastBusyAt: number
    cursorPosition?: { row: number; col: number } | null
    completionIdleDebounce?: { active: boolean; ageMs: number; holdMs: number; forceAfterMs: number } | null
    fsm?: unknown
    name?: string
    status?: string
    workingDir?: string
    spawnedAtMs?: number
    providerSessionId?: string | null
    messages?: Array<{ role: string; content: string; receivedAt?: number }>
    committedMessages?: Array<{ role: string; content: string; receivedAt?: number }>
    /** True when the snapshot came from a native-source / non-FSM provider, so
     *  state-machine sections (State History, FSM, Sections) are N/A. */
    nativeSource: boolean
    /** transcriptAuthority reported by the provider (e.g. 'provider'), when known. */
    transcriptAuthority?: string
}

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : ''
}

/**
 * True when the raw snapshot carries state-machine rule fields — i.e. it came
 * from the spec-driven adapter. A snapshot with a `spec_id`, a `current_state`
 * key, or a `stateHistory` array is spec-shaped; anything else is treated as a
 * native-source / legacy diagnostics snapshot.
 */
export function isSpecShapedSnapshot(raw: unknown): boolean {
    const r = asRecord(raw)
    if (typeof r.spec_id === 'string' && r.spec_id.length > 0) return true
    if ('current_state' in r) return true
    if (Array.isArray(r.stateHistory)) return true
    return false
}

/** Map the legacy ProviderCliAdapter `{ message, buttons: string[] }` modal (or
 *  a parsedStatusCache.activeModal of the same shape) to the panel modal. */
function normalizeLegacyModal(raw: Record<string, unknown>): NormalizedSpecSnapshot['current_modal'] {
    const parser = asRecord(raw.parser)
    const parsedCache = asRecord(parser.parsedStatusCache)
    const modal = asRecord(raw.activeModal).buttons != null
        ? asRecord(raw.activeModal)
        : asRecord(parsedCache.activeModal)
    const buttons = Array.isArray(modal.buttons) ? (modal.buttons as unknown[]) : null
    if (!buttons || buttons.length === 0) {
        // A modal with only a message and no buttons is still worth surfacing.
        const message = str(modal.message) || str(modal.title)
        if (!message) return null
        return { title: message, buttons: [] }
    }
    return {
        title: str(modal.message) || str(modal.title) || null,
        buttons: buttons.map((b, index) => ({ index, label: typeof b === 'string' ? b : String(b) })),
    }
}

/** Extract transcript messages from the legacy diagnostics snapshot. The
 *  ProviderCliAdapter snapshot doesn't inline messages, but getDebugState does;
 *  accept either `messages` at the root or `parser.parsedStatusCache.messages`. */
function normalizeLegacyMessages(raw: Record<string, unknown>): NormalizedSpecSnapshot['messages'] {
    const direct = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : null
    if (direct) {
        return direct
            .map(m => asRecord(m))
            .filter(m => typeof m.role === 'string')
            .map(m => ({ role: str(m.role), content: str(m.content), receivedAt: typeof m.receivedAt === 'number' ? m.receivedAt : undefined }))
    }
    return []
}

/**
 * Normalize a raw adapter snapshot (either shape) into the panel's snapshot.
 * Returns null only when there is genuinely nothing to show.
 */
export function normalizeSpecSnapshot(raw: unknown): NormalizedSpecSnapshot | null {
    if (raw == null || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>

    if (isSpecShapedSnapshot(raw)) {
        // Already the panel shape — pass through, defaulting the fields the panel
        // reads and tagging it as spec-driven (not native-source).
        return {
            cliType: str(r.cliType),
            spec_id: str(r.spec_id),
            specPath: typeof r.specPath === 'string' ? r.specPath : undefined,
            current_state: (r.current_state as NormalizedSpecSnapshot['current_state']) ?? null,
            current_modal: (r.current_modal as NormalizedSpecSnapshot['current_modal']) ?? null,
            activeInteractivePrompt: r.activeInteractivePrompt,
            exited: r.exited === true,
            screen: str(r.screen),
            sections: (r.sections as Record<string, string> | undefined) ?? undefined,
            stateHistory: Array.isArray(r.stateHistory) ? (r.stateHistory as Array<Record<string, unknown>>) : [],
            idleHoldPending: r.idleHoldPending === true,
            lastBusyAt: typeof r.lastBusyAt === 'number' ? r.lastBusyAt : 0,
            cursorPosition: (r.cursorPosition as NormalizedSpecSnapshot['cursorPosition']) ?? null,
            completionIdleDebounce: (r.completionIdleDebounce as NormalizedSpecSnapshot['completionIdleDebounce']) ?? null,
            fsm: r.fsm ?? null,
            name: typeof r.name === 'string' ? r.name : undefined,
            status: typeof r.status === 'string' ? r.status : undefined,
            workingDir: typeof r.workingDir === 'string' ? r.workingDir : undefined,
            spawnedAtMs: typeof r.spawnedAtMs === 'number' ? r.spawnedAtMs : undefined,
            providerSessionId: (r.providerSessionId as string | null | undefined) ?? null,
            messages: (r.messages as NormalizedSpecSnapshot['messages']) ?? undefined,
            committedMessages: (r.committedMessages as NormalizedSpecSnapshot['messages']) ?? undefined,
            nativeSource: false,
            transcriptAuthority: undefined,
        }
    }

    // ── Native-source / legacy diagnostics shape (e.g. kimi provider.v1.json).
    //    Map whatever is available; state-machine sections stay empty and the
    //    nativeSource flag tells the panel to render them as N/A.
    const terminal = asRecord(r.terminal)
    const parser = asRecord(r.parser)
    const parsedCache = asRecord(parser.parsedStatusCache)
    const runtimeMeta = asRecord(r.runtimeMetadata)

    const screen = str(terminal.screenText) || str(terminal.lastScreenText) || str(r.screenText)
    const status = str(parsedCache.status) || str(r.currentStatus) || str(r.status)
    const providerSessionId = str(parsedCache.providerSessionId) || str(runtimeMeta.providerSessionId) || null
    const transcriptAuthority = str(parsedCache.transcriptAuthority) || str(r.transcriptAuthority) || undefined

    return {
        cliType: str(r.cliType) || str(r.type),
        // No spec id for a native-source provider — surface the provider type so
        // the header chip isn't blank.
        spec_id: str(r.cliType) || str(r.type) || 'native-source',
        specPath: typeof r.specPath === 'string' ? r.specPath : undefined,
        current_state: status ? { id: status, label: status, title: null } : null,
        current_modal: normalizeLegacyModal(r),
        activeInteractivePrompt: r.activeInteractivePrompt ?? null,
        exited: r.exited === true,
        screen,
        sections: undefined,
        stateHistory: [],
        idleHoldPending: false,
        lastBusyAt: typeof r.lastBusyAt === 'number' ? r.lastBusyAt : 0,
        cursorPosition: null,
        completionIdleDebounce: null,
        fsm: null,
        name: str(r.cliName) || str(r.name) || undefined,
        status: status || undefined,
        workingDir: typeof r.workingDir === 'string' ? r.workingDir : undefined,
        spawnedAtMs: typeof runtimeMeta.spawnedAtMs === 'number' ? runtimeMeta.spawnedAtMs
            : typeof r.spawnAt === 'number' ? (r.spawnAt as number) : undefined,
        providerSessionId,
        messages: normalizeLegacyMessages(r),
        committedMessages: undefined,
        nativeSource: true,
        transcriptAuthority,
    }
}
