// @vitest-environment jsdom
/**
 * Bold that CommonMark leaves literal next to CJK text (2026-10-18: the
 * assistant's "지금 확인이 필요한 곳은 **[todo-web]**이에요." showed raw `**`).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatMarkdownBody } from '../../src/components/ChatMessageList/chat-row-content'
import { splitCjkStrong } from '../../src/components/ChatMessageList/remark-cjk-strong'

const md = (content: string) => renderToStaticMarkup(createElement(ChatMarkdownBody, { content, renderAsPreformatted: false, renderAsMarkdown: true }))

describe('CJK-adjacent bold', () => {
    it('renders bold that closes right before Korean text', () => {
        const html = md('지금 확인이 필요한 곳은 **[todo-web]**이에요.')
        expect(html).toContain('<strong>[todo-web]</strong>이에요')
        expect(html).not.toContain('**')
    })
    it('handles punctuation inside the bold and Japanese / Chinese neighbours', () => {
        expect(md('**完了。**しました')).toContain('<strong>完了。</strong>しました')
        expect(md('结果是**「成功」**了')).toContain('<strong>「成功」</strong>了')
    })
    it('leaves ordinary bold, escaped asterisks and code alone', () => {
        expect(md('This is **bold** text')).toContain('<strong>bold</strong>')
        expect(md('literal \\*\\*not bold\\*\\* here')).toContain('**not bold**')
        expect(md('`**[x]**이에요`')).toContain('<code>**[x]**이에요</code>')
    })
    it('only acts when a CJK character touches the pair', () => {
        expect(splitCjkStrong('a **[x]**b')).toBeNull()
        expect(splitCjkStrong('가 **[x]**나')?.map((n) => n.type)).toEqual(['text', 'strong', 'text'])
    })
})
