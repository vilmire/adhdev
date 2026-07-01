import { describe, it, expect } from 'vitest'
import { sanitizePastedText } from '../../src/utils/text'

describe('sanitizePastedText', () => {
    describe('strips rendering artifacts', () => {
        it('removes C0 control chars but preserves \\n and \\t', () => {
            // \x00 NUL, \x07 BEL, \x1B ESC around normal text.
            expect(sanitizePastedText('a\x00b\x07c\x1Bd')).toBe('abcd')
            expect(sanitizePastedText('line1\nline2\tcol')).toBe('line1\nline2\tcol')
        })

        it('removes DEL and C1 control chars', () => {
            expect(sanitizePastedText('x\x7Fy\x85z\x9Fw')).toBe('xyzw')
        })

        it('removes zero-width / BOM / directional formatting marks', () => {
            // ZWSP, ZWNJ, ZWJ standalone, LRM, RLM, WORD JOINER, BOM.
            const input = 'a​b‌c‍d‎e‏f⁠g﻿h'
            expect(sanitizePastedText(input)).toBe('abcdefgh')
            // Directional overrides.
            expect(sanitizePastedText('x‪y‮z')).toBe('xyz')
        })

        it("removes the replacement character (mojibake '�')", () => {
            expect(sanitizePastedText('foo�bar')).toBe('foobar')
        })

        it('strips a marker glyph that degraded into control/replacement junk', () => {
            // Simulates a copied ⏸ marker that arrived as control + replacement bytes.
            const junk = '\x02� Paused'
            expect(sanitizePastedText(junk)).toBe(' Paused')
        })

        it('removes orphaned variation selectors', () => {
            // VS16 with no preceding base glyph.
            expect(sanitizePastedText('️hello')).toBe('hello')
            // VS15 after whitespace (base was stripped).
            expect(sanitizePastedText('a ︎b')).toBe('a b')
        })
    })

    describe('preserves legitimate content', () => {
        it('leaves plain text unchanged (identity → no mutation)', () => {
            const s = 'The quick brown fox jumps over the lazy dog.'
            expect(sanitizePastedText(s)).toBe(s)
        })

        it('preserves Korean text', () => {
            const s = '안녕하세요 반갑습니다 붙여넣기 테스트'
            expect(sanitizePastedText(s)).toBe(s)
        })

        it('preserves newlines and code characters', () => {
            const code = 'function f() {\n\tconst x = a & b | c;\n\treturn x <= 10;\n}'
            expect(sanitizePastedText(code)).toBe(code)
        })

        it('preserves normal emoji including attached variation selectors', () => {
            // ⏸️ (pause with VS16), heart with VS16, plain grinning face.
            const s = '⏸️ pause ❤️ love \u{1F600} grin'
            expect(sanitizePastedText(s)).toBe(s)
        })

        it('is idempotent on already-clean mixed content', () => {
            const s = 'Hello 세계 \u{1F44D} — code `a && b`\nnext line'
            expect(sanitizePastedText(s)).toBe(s)
        })
    })
})
