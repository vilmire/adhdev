/**
 * chat-id-links — pure part of "identifiers in chat bubbles become links".
 *
 * Detection is shape-only (`art_<16 hex>`, `mi_<12 hex>`, UUID); whether an id becomes a
 * link is decided by the resolver the host supplies, which answers only for ids the
 * dashboard actually knows. An unknown UUID therefore never turns into a link. Nothing
 * here edits stored text: both the markdown plugin and the plain-text splitter only change
 * what is rendered. Fenced/indented code and existing links are never touched; an inline
 * code span is linked only when its whole content is exactly one known id.
 */

export type ChatIdTarget =
    | { kind: 'artifact'; id: string }
    | { kind: 'session'; id: string }
    | { kind: 'decision'; id: string; meshId: string }
    | { kind: 'mission'; id: string; meshId: string }
    | { kind: 'task'; id: string; meshId: string }

export type ChatIdResolver = (id: string) => ChatIdTarget | null

/** href scheme the markdown plugin emits; the `a` override recognises it. */
export const CHAT_ID_HREF_PREFIX = 'adhdev-id:'

const ARTIFACT_ID = /^art_[0-9a-f]{16}$/
const DECISION_ID = /^mi_[0-9a-f]{12}$/
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isChatIdShape(value: string): boolean {
    return ARTIFACT_ID.test(value) || DECISION_ID.test(value) || UUID_ID.test(value)
}

/** Cheap pre-check so ordinary messages skip the scan entirely. */
export function textMayContainChatIds(text: string): boolean {
    return text.includes('art_') || text.includes('mi_') || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)
}

const CANDIDATE = /art_[0-9a-f]{16}|mi_[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const WORD = /[A-Za-z0-9_-]/

export type ChatIdPiece = string | { id: string; target: ChatIdTarget }

/** Split `text` into plain strings and resolved ids; null when nothing resolves. */
export function splitTextByChatIds(text: string, resolve: ChatIdResolver): ChatIdPiece[] | null {
    if (!textMayContainChatIds(text)) return null
    const out: ChatIdPiece[] = []
    let last = 0
    CANDIDATE.lastIndex = 0
    for (let m = CANDIDATE.exec(text); m; m = CANDIDATE.exec(text)) {
        const before = m.index > 0 ? text[m.index - 1]! : ''
        const after = text[m.index + m[0].length] ?? ''
        // Whole-token only: `x-<uuid>` or `<uuid>-1` is some other identifier.
        if ((before && WORD.test(before)) || (after && WORD.test(after))) continue
        const target = resolve(m[0])
        if (!target) continue
        if (m.index > last) out.push(text.slice(last, m.index))
        out.push({ id: m[0], target })
        last = m.index + m[0].length
    }
    if (!out.length) return null
    if (last < text.length) out.push(text.slice(last))
    return out
}

interface MdNode {
    type: string
    value?: string
    url?: string
    children?: MdNode[]
}

const SKIP = new Set(['code', 'link', 'linkReference', 'definition', 'html', 'inlineCode', 'image', 'imageReference'])

function linkNode(id: string, children: MdNode[]): MdNode {
    return { type: 'link', url: `${CHAT_ID_HREF_PREFIX}${id}`, children }
}

function walk(node: MdNode, resolve: ChatIdResolver): void {
    const children = node.children
    if (!children) return
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!
        if (child.type === 'inlineCode') {
            const value = (child.value ?? '').trim()
            if (isChatIdShape(value) && resolve(value)) children[i] = linkNode(value, [child])
            continue
        }
        if (child.type === 'text' && child.value) {
            const pieces = splitTextByChatIds(child.value, resolve)
            if (pieces) {
                const nodes = pieces.map<MdNode>(p => typeof p === 'string'
                    ? { type: 'text', value: p }
                    : linkNode(p.id, [{ type: 'text', value: p.id }]))
                children.splice(i, 1, ...nodes)
                i += nodes.length - 1
            }
            continue
        }
        if (SKIP.has(child.type)) continue
        walk(child, resolve)
    }
}

/** remark plugin: `[[remarkChatIdLinks, { resolve }]]`. */
export default function remarkChatIdLinks(options: { resolve: ChatIdResolver }) {
    return (tree: MdNode) => { walk(tree, options.resolve) }
}
