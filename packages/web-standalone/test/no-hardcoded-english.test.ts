// Gate: no new hard-coded English copy in web-standalone UI (i18n sweep, 2026-09-26).
//
// web-standalone has no locale files of its own — every component consumes
// web-core's `common` i18n namespace via react-i18next. This guard reuses
// web-core's shared scanner (test/i18n/hardcoded-english-scanner.ts) against
// web-standalone's own .tsx tree, the same way web-cloud does, so English
// literals written straight into standalone-only JSX (settings, layout, about,
// onboarding, setup wizard) don't slip past the web-core-only sweep.
//
// Intentional literals (brand name, edition badges, code/shell examples) are
// listed in ALLOWED per file — adding copy means adding an i18n key in
// oss/packages/web-core/src/i18n/locales/*/common.json, not an allow entry.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { scanHardcodedEnglish } from '../../web-core/test/i18n/hardcoded-english-scanner.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(packageRoot, 'src')

/** Per-file literals that are not translatable copy. */
const ALLOWED: Record<string, string[]> = {
    // Brand name (logo alt text / footer wordmark) — matches web-core's
    // ALLOWED['ADHDev'] convention for the same brand literal.
    'StandaloneLayout.tsx': ['ADHDev', 'Selfhost v'],
    // Edition badge on the About page header ("SELFHOST v1.2.3").
    'StandaloneAbout.tsx': ['SELFHOST v'],
    // Demo agent persona name in the font-preview chat bubble (proper noun,
    // same treatment as a brand name — not generic UI copy). The other two
    // entries are a literal code snippet and a literal shell transcript in
    // the same live-preview card, shown verbatim to demonstrate font
    // rendering — same treatment as InstallCommand.tsx's literal commands.
    'StandaloneFontSettingsSection.tsx': [
        'Hermes',
        "const message = 'standalone custom fonts'",
        '$ npm run dev:standalone\\nready on http://localhost:3847',
    ],
}

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path, out)
        else if (path.endsWith('.tsx')) out.push(path)
    }
    return out
}

const FILES = walk(SRC).map(abs => relative(SRC, abs)).sort()

test('scans the whole web-standalone component tree (not an accidentally empty glob)', () => {
    // 9 .tsx files at introduction; fail loudly if the walk breaks.
    assert.ok(FILES.length >= 9, `expected at least 9 .tsx files, found ${FILES.length}`)
    for (const file of Object.keys(ALLOWED)) {
        assert.ok(FILES.includes(file), `ALLOWED key ${file} not found in scanned files`)
    }
})

test('every user-visible literal in web-standalone goes through i18n (or is explicitly allowed)', () => {
    const offenders: string[] = []
    for (const file of FILES) {
        const allowed = new Set(ALLOWED[file] ?? [])
        for (const hit of scanHardcodedEnglish(file, readFileSync(join(SRC, file), 'utf8'))) {
            if (!allowed.has(hit.text)) offenders.push(`${file}:${hit.line} ${JSON.stringify(hit.text)}`)
        }
    }
    assert.deepEqual(offenders, [], `Route these through t('…') with keys in all 5 locales:\n${offenders.join('\n')}`)
})

test('has no stale allowances', () => {
    const stale: string[] = []
    for (const [file, texts] of Object.entries(ALLOWED)) {
        const found = new Set(scanHardcodedEnglish(file, readFileSync(join(SRC, file), 'utf8')).map(h => h.text))
        for (const text of texts) if (!found.has(text)) stale.push(`${file} ${JSON.stringify(text)}`)
    }
    assert.deepEqual(stale, [])
})
