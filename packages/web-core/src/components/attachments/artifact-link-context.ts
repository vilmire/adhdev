import { createContext } from 'react'

/**
 * Relative-link handling inside artifact markdown. A link such as
 * `[spec](docs/receipt-spec-2.md)` points at a workspace file, never at an app
 * route, so it must never navigate the dashboard. The viewer's host may supply a
 * resolver that maps the href onto another artifact of the same list; it returns
 * an opener, or null when no artifact matches (the link then renders as plain,
 * non-navigating text whose title shows the path).
 */
export type ArtifactLinkResolver = (href: string) => (() => void) | null

export const ArtifactLinkContext = createContext<ArtifactLinkResolver | null>(null)

function normalizeArtifactPath(raw: string): string {
    let p = raw.trim().replace(/[?#].*$/, '')
    try { p = decodeURIComponent(p) } catch { /* keep raw */ }
    p = p.replace(/\\/g, '/')
    const out: string[] = []
    for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue
        if (seg === '..') { out.pop(); continue }
        out.push(seg)
    }
    return out.join('/').toLowerCase()
}

/**
 * Index of the artifact an href refers to: an exact/suffix match on `relPath`
 * first, else a UNIQUE filename match. -1 when nothing (or something ambiguous) matches.
 */
export function findArtifactByLink(href: string, items: ReadonlyArray<{ filename: string; relPath?: string }>): number {
    const target = normalizeArtifactPath(href)
    if (!target) return -1
    const withPath = items.map((it, i) => ({ i, p: it.relPath ? normalizeArtifactPath(it.relPath) : '' })).filter(x => x.p)
    const pathHit = withPath.find(x => x.p === target || x.p.endsWith(`/${target}`) || target.endsWith(`/${x.p}`))
    if (pathHit) return pathHit.i
    const base = target.split('/').pop() ?? ''
    const byName = items.map((it, i) => ({ i, n: normalizeArtifactPath(it.filename) })).filter(x => x.n === base)
    return byName.length === 1 ? byName[0].i : -1
}
