// Shared scanner for the "no new hard-coded English in the UI" guards
// (web-core: test/i18n/no-hardcoded-english.test.ts; web-cloud reuses it).
//
// It parses TSX with the TypeScript compiler (no regex over markup) and reports
// user-visible string literals that bypass i18n:
//   1. JSX text nodes            <span>Refresh</span>
//   2. string-valued visible props  title="…" placeholder="…" aria-label="…" label="…" …
//   3. string literals that ARE the rendered value of a JSX expression or a
//      visible prop — branches of `?:`, operands of `||` / `??` / `&& 'x'`:
//      {busy ? 'Loading…' : 'Refresh'}   title={x || 'Remote'}
//
// Deliberately NOT reported: call arguments (t('key'), cn('…')), className and
// other non-visible props, template literals with substitutions, and JSX under
// a literal `{false && (…)}` (dead code kept for reference).
import ts from 'typescript'

export const VISIBLE_PROPS = new Set([
    'title', 'placeholder', 'aria-label', 'label', 'description', 'alt',
    'tooltip', 'hint', 'emptyText', 'emptyMessage', 'helperText', 'subtitle', 'confirmLabel', 'cancelLabel',
])

export interface HardcodedHit {
    line: number
    text: string
}

/** Tailwind-ish class lists / identifiers are not copy. */
function looksLikeClassList(s: string): boolean {
    const words = s.trim().split(/\s+/)
    return words.length > 0 && words.every(w => /^[!a-z0-9:/[\]._%#()-]+$/.test(w)) && /-/.test(s)
}

/** Inline <style> bodies (keyframes etc.) are CSS, not copy. */
function looksLikeCss(s: string): boolean {
    return /[{}]/.test(s) && /;/.test(s) && /:/.test(s)
}

function isEnglishCopy(s: string): boolean {
    const text = s.trim()
    if (!text || looksLikeCss(text)) return false
    if (!/[A-Za-z]{2,}/.test(text) || !/[a-z]/.test(text)) return false
    return !looksLikeClassList(text)
}

function isDeadFalseBranch(node: ts.Node): boolean {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
        if (ts.isBinaryExpression(p)
            && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            && p.left.kind === ts.SyntaxKind.FalseKeyword) return true
    }
    return false
}

/** Is this literal the rendered value of a JSX child expression or a visible prop? */
function isRenderedLiteral(node: ts.Node): boolean {
    let child: ts.Node = node
    let p: ts.Node | undefined = node.parent
    while (p) {
        if (ts.isJsxExpression(p)) {
            const owner = p.parent
            if (owner && ts.isJsxAttribute(owner)) return VISIBLE_PROPS.has(owner.name.getText())
            return true
        }
        if (ts.isConditionalExpression(p)) {
            if (p.condition === child) return false
        } else if (ts.isBinaryExpression(p)) {
            const k = p.operatorToken.kind
            if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
                if (p.left === child) return false
            } else if (k !== ts.SyntaxKind.BarBarToken && k !== ts.SyntaxKind.QuestionQuestionToken) {
                return false
            }
        } else if (!ts.isParenthesizedExpression(p)) {
            return false
        }
        child = p
        p = p.parent
    }
    return false
}

export function scanHardcodedEnglish(fileName: string, source: string): HardcodedHit[] {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const hits: HardcodedHit[] = []
    const push = (node: ts.Node, text: string) => {
        if (isDeadFalseBranch(node)) return
        hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.replace(/\s+/g, ' ').trim() })
    }
    const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
            if (isEnglishCopy(node.text)) push(node, node.text)
        } else if (ts.isJsxAttribute(node) && node.initializer) {
            const name = node.name.getText(sf)
            const init = node.initializer
            if (VISIBLE_PROPS.has(name) && ts.isStringLiteral(init) && isEnglishCopy(init.text)) push(node, init.text)
        } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            && !ts.isJsxAttribute(node.parent)
            && isEnglishCopy(node.text)
            && isRenderedLiteral(node)) {
            push(node, node.text)
        }
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return hits
}
