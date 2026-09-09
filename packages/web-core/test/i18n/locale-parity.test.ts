// Locale parity gate (M-WEBCORE-TEST-SUITE-RED, 2026-09-10).
//
// The five catalogs drift key-by-key: a copy rewrite lands in en/ko while
// ja/es/zh-CN keep the retired keys (landing.scenario.step4/5), or a feature
// adds en/ko strings without the other three (interactivePrompt.answersRequired).
// The existing i18n tests each pin a specific key list, so a drift outside
// those lists sails through. This gate compares the FULL key sets instead.
//
// Two deliberate design points:
// - i18next plural suffixes (_zero/_one/_two/_few/_many/_other) are collapsed
//   to their base key before comparing, because CLDR plural categories differ
//   per language (ja/ko/zh-CN only have "other"; es has one/many/other). Raw
//   key-set equality would be a permanent false positive. A separate check
//   still requires every pluralized group to carry its "_other" form, which
//   every CLDR language resolves.
// - Duplicate keys are detected on the RAW file text with a mini JSON walker.
//   JSON.parse (and any load-then-dump editing round trip) silently keeps the
//   last duplicate, which is exactly the loss mode this guards against.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

const LOCALES = [...SUPPORTED_LANGUAGES]
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function rawCatalog(locale: string): string {
    return readFileSync(new URL(`../../src/i18n/locales/${locale}/common.json`, import.meta.url), 'utf8')
}

function flattenKeys(obj: Record<string, unknown>, prefix = '', out: string[] = []): string[] {
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            flattenKeys(v as Record<string, unknown>, path, out)
        } else {
            out.push(path)
        }
    }
    return out
}

// Walks the raw JSON text and returns the dot-path of every key that appears
// more than once inside the same object. Assumes the input is valid JSON
// (JSON.parse in the parity tests would throw first otherwise).
function findDuplicateKeys(raw: string): string[] {
    const dups: string[] = []
    let i = 0
    const skipWs = () => {
        while (i < raw.length && ' \t\n\r'.includes(raw[i])) i++
    }
    const parseString = (): string => {
        i++ // opening quote
        let out = ''
        while (raw[i] !== '"') {
            if (raw[i] === '\\') {
                out += raw[i] + raw[i + 1]
                i += 2
            } else {
                out += raw[i++]
            }
        }
        i++ // closing quote
        return out
    }
    const parseValue = (path: string): void => {
        skipWs()
        const c = raw[i]
        if (c === '{') parseObject(path)
        else if (c === '[') parseArray(path)
        else if (c === '"') parseString()
        else {
            while (i < raw.length && !',}]'.includes(raw[i]) && !' \t\n\r'.includes(raw[i])) i++
        }
    }
    const parseArray = (path: string): void => {
        i++ // [
        skipWs()
        if (raw[i] === ']') {
            i++
            return
        }
        for (;;) {
            parseValue(path)
            skipWs()
            if (raw[i] === ',') {
                i++
                continue
            }
            i++ // ]
            return
        }
    }
    const parseObject = (path: string): void => {
        i++ // {
        const seen = new Set<string>()
        skipWs()
        if (raw[i] === '}') {
            i++
            return
        }
        for (;;) {
            skipWs()
            const key = parseString()
            const keyPath = path ? `${path}.${key}` : key
            if (seen.has(key)) dups.push(keyPath)
            seen.add(key)
            skipWs()
            i++ // :
            parseValue(keyPath)
            skipWs()
            if (raw[i] === ',') {
                i++
                continue
            }
            i++ // }
            return
        }
    }
    parseValue('')
    return dups
}

const rawByLocale = new Map(LOCALES.map((l) => [l, rawCatalog(l)]))
const keysByLocale = new Map(LOCALES.map((l) => [l, flattenKeys(JSON.parse(rawByLocale.get(l)!))]))
const normalizedByLocale = new Map(
    LOCALES.map((l) => [l, new Set(keysByLocale.get(l)!.map((k) => k.replace(PLURAL_SUFFIX, '')))]),
)

describe('locale catalog parity', () => {
    it('covers exactly the five supported locales', () => {
        expect(LOCALES).toEqual(['en', 'ko', 'ja', 'zh-CN', 'es'])
    })

    for (const locale of LOCALES) {
        it(`${locale}: no duplicate keys in the raw JSON`, () => {
            expect(findDuplicateKeys(rawByLocale.get(locale)!)).toEqual([])
        })
    }

    for (const locale of LOCALES.filter((l) => l !== 'en')) {
        it(`${locale}: same key set as en (plural-suffix normalized)`, () => {
            const en = normalizedByLocale.get('en')!
            const loc = normalizedByLocale.get(locale)!
            const missing = [...en].filter((k) => !loc.has(k)).sort()
            const extra = [...loc].filter((k) => !en.has(k)).sort()
            expect({ missing, extra }).toEqual({ missing: [], extra: [] })
        })
    }

    for (const locale of LOCALES) {
        it(`${locale}: every pluralized key group has an _other form`, () => {
            const keys = new Set(keysByLocale.get(locale)!)
            const broken: string[] = []
            for (const key of keys) {
                const m = key.match(PLURAL_SUFFIX)
                if (!m) continue
                const base = key.replace(PLURAL_SUFFIX, '')
                if (!keys.has(`${base}_other`) && !keys.has(base)) broken.push(base)
            }
            expect([...new Set(broken)].sort()).toEqual([])
        })
    }
})
