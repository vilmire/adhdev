/**
 * remark-cjk-strong — bold that CommonMark leaves unparsed next to CJK text.
 *
 * A closing `**` is right-flanking only if it is not preceded by punctuation or
 * is followed by whitespace/punctuation. Korean, Japanese and Chinese put no
 * space after a bold word, so `**[todo-web]**이에요` or `**완료.**했어요` stays
 * literal `**` on screen. This pass turns such a leftover `**text**` in a text
 * node into a `strong` node — only when a CJK character touches the outer side
 * of the pair, which is exactly the case the parser rejects; an escaped literal
 * `\*\*` elsewhere is left alone.
 */

interface MdNode {
    type: string;
    value?: string;
    children?: MdNode[];
}

const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;
const PAIR = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;

/** Split one text value into text / strong pieces, or null when nothing applies. */
export function splitCjkStrong(value: string): MdNode[] | null {
    const out: MdNode[] = [];
    let last = 0;
    PAIR.lastIndex = 0;
    for (let m = PAIR.exec(value); m; m = PAIR.exec(value)) {
        const before = m.index > 0 ? value[m.index - 1]! : '';
        const after = value[m.index + m[0].length] ?? '';
        if (!CJK.test(before) && !CJK.test(after)) continue;
        if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
        out.push({ type: 'strong', children: [{ type: 'text', value: m[1] }] });
        last = m.index + m[0].length;
    }
    if (!out.length) return null;
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
    return out;
}

function walk(node: MdNode): void {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.type === 'text' && child.value && child.value.includes('**')) {
            const pieces = splitCjkStrong(child.value);
            if (pieces) {
                children.splice(i, 1, ...pieces);
                i += pieces.length - 1;
            }
            continue;
        }
        walk(child);
    }
}

export default function remarkCjkStrong() {
    return (tree: MdNode) => { walk(tree); };
}
