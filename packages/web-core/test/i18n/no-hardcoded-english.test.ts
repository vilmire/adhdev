// Gate: no new hard-coded English copy in web-core UI (i18n sweep, 2026-09-25).
//
// The dashboard ships in five languages, but English kept leaking into the
// Korean UI through literals written straight into JSX ("Saved history",
// "Refresh", "Mobile Inbox (Chat Mode)", "Preview daemon is up to date", …).
// The locale-parity gate cannot see those — they never touch a catalog.
//
// This test parses every web-core .tsx (TypeScript AST, see
// hardcoded-english-scanner.ts) and fails on any user-visible English literal
// that is not routed through i18n. Intentional literals (brand names, keyboard
// key names, shell commands, example paths/URLs, code tokens) are listed in
// ALLOWED per file — adding copy means adding an i18n key, not an allow entry.
//
// Scope decisions:
//  - EXCLUDED_FILES are developer tooling (provider spec debugger / FSM form
//    builder) that is intentionally English-only.
//  - ALLOWED entries must still match something, so a stale allowance fails
//    the gate instead of silently widening it.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanHardcodedEnglish } from './hardcoded-english-scanner'

const SRC = join(import.meta.dirname, '../../src')

/** Developer-only surfaces, deliberately English. */
const EXCLUDED_FILES = new Set([
    'components/dashboard/SpecDebugPanel.tsx',
    'components/dashboard/SpecFormBuilder.tsx',
])

/** Per-file literals that are not translatable copy. */
const ALLOWED: Record<string, string[]> = {
    // Platform / shell names and literal commands.
    'components/InstallCommand.tsx': ['macOS / Linux', 'Windows', 'PowerShell', '&gt;_ CMD', 'npm i -g @adhdev/daemon-standalone && adhdev-standalone', 'npm i -g adhdev && adhdev login'],
    // Compact DAG glyph suffix next to an FSM state id.
    'components/MeshGraph/MeshMiniDag.tsx': ['· if'],
    // Brand logo alt text.
    'components/dashboard/ChatPane.tsx': ['ADHDev'],
    'components/dashboard/DashboardMobileChatInbox.tsx': ['ADHDev'],
    'components/dashboard/PaneGroupEmptyState.tsx': ['ADHDev'],
    'pages/Machines.tsx': ['ADHDev'],
    // Keyboard key names on the terminal key pad.
    'components/dashboard/CliTerminalPane.tsx': ['Esc', 'Tab', 'Enter', 'Ctrl-C', 'Space', 'Bksp'],
    // Command name / brand link / close glyph entity.
    'components/git/GitDiffPreview.tsx': ['git diff'],
    'components/git/GitStatusDialog.tsx': ['GitHub ↗', '&times;'],
    // Example input placeholders (URLs, paths, identifiers).
    'components/mesh-onboarding/MeshCreateForm.tsx': ['https://github.com/user/repo', 'github.com/user/repo'],
    'pages/repo-mesh/MeshNodeList.tsx': ['/Users/dev/projects/myapp'],
    'pages/repo-mesh/NodeSlotEditor.tsx': ['worktree, os=darwin'],
    'pages/machine/SourcesPanel.tsx': ['main', '@vendor-extra-providers'],
    // Unit suffix next to a number input.
    'components/settings/ChatThemeSection.tsx': ['px'],
    // A filesystem path and prompt template placeholders shown verbatim.
    'components/settings/CoordinatorPromptsSection.tsx': ['~/.adhdev/coordinator-prompts/', '{{meshName}}', '{{repo}}', '{{nodes}}', '{{rules}}'],
    // Product name used as a page title / fallback subtitle.
    'pages/RepoMesh.tsx': ['Repo Mesh'],
    'pages/repo-mesh/MeshDetailView.tsx': ['Repo Mesh'],
    // Log filter field names (query syntax).
    'pages/machine/LogsTabSections.tsx': ['topic=', 'ix='],
    // Session-kind acronyms.
    'pages/machine/OverviewTab.tsx': ['IDEs', 'CLIs', 'ACPs'],
    // Provider source-mode enum values (Advanced panel; the value IS the setting).
    'pages/machine/ProvidersTab.tsx': ['normal'],
    // OS process id label.
    'pages/machine/SessionHostPanel.tsx': ['pid'],
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

describe('no hard-coded English UI copy in web-core', () => {
    it('scans the whole component tree (not an accidentally empty glob)', () => {
        // 168 .tsx files at introduction; fail loudly if the walk breaks.
        expect(FILES.length).toBeGreaterThanOrEqual(150)
        for (const excluded of EXCLUDED_FILES) expect(FILES, excluded).toContain(excluded)
        for (const file of Object.keys(ALLOWED)) expect(FILES, `ALLOWED key ${file}`).toContain(file)
    })

    it('every user-visible literal goes through i18n (or is explicitly allowed)', () => {
        const offenders: string[] = []
        for (const file of FILES) {
            if (EXCLUDED_FILES.has(file)) continue
            const allowed = new Set(ALLOWED[file] ?? [])
            for (const hit of scanHardcodedEnglish(file, readFileSync(join(SRC, file), 'utf8'))) {
                if (!allowed.has(hit.text)) offenders.push(`${file}:${hit.line} ${JSON.stringify(hit.text)}`)
            }
        }
        expect(offenders, `Route these through t('…') with keys in all 5 locales:\n${offenders.join('\n')}`).toEqual([])
    })

    it('has no stale allowances', () => {
        const stale: string[] = []
        for (const [file, texts] of Object.entries(ALLOWED)) {
            const found = new Set(scanHardcodedEnglish(file, readFileSync(join(SRC, file), 'utf8')).map(h => h.text))
            for (const text of texts) if (!found.has(text)) stale.push(`${file} ${JSON.stringify(text)}`)
        }
        expect(stale).toEqual([])
    })
})

describe('hard-coded English scanner', () => {
    it('flags text nodes, visible props and rendered literals; ignores t() args, classes and dead code', () => {
        const hits = scanHardcodedEnglish('x.tsx', `
            const A = () => <div className="text-xs font-bold" title="Open it">
                <span>Refresh</span>
                {busy ? 'Loading…' : t('ok')}
                {label || 'Remote'}
                {t('already.translated')}
                {false && (<p>Dead copy</p>)}
            </div>
        `).map(h => h.text)
        expect(hits).toEqual(['Open it', 'Refresh', 'Loading…', 'Remote'])
    })
})
