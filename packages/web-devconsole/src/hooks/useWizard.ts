import { useState } from 'react'
import { api } from '../api'
import type { AppendOutput } from '../shared'

/**
 * Selector Finder ("Wizard" tab) state — tag-based include/exclude text
 * conditions with an automatic common-ancestor query, plus the inline
 * children preview of a candidate selector.
 */
export function useWizard(ideTarget: string, appendOutput: AppendOutput) {
  const [search, setSearch] = useState('')
  const [includes, setIncludes] = useState<string[]>([])
  const [excludes, setExcludes] = useState<string[]>([])
  const [results, setResults] = useState<any>(null)
  const [preview, setPreview] = useState<{ selector: string; items: any[] } | null>(null)
  const [searching, setSearching] = useState(false)

  async function runQuery(inc: string[], exc: string[]) {
    setSearching(true)
    try {
      const result = await api.findCommon(inc, exc, ideTarget || undefined)
      setResults(result)
      appendOutput(`🔍 ${result?.results?.length || 0} common ancestors for ${inc.length} includes`, 'result')
    } catch (err: any) { appendOutput('Query failed: ' + err.message, 'error') }
    setSearching(false)
  }

  async function addCondition() {
    if (!search.trim()) return
    const raw = search.trim()
    const isExclude = raw.startsWith('!') || raw.startsWith('-')
    const text = isExclude ? raw.slice(1).trim() : raw
    if (!text) return

    const newIncludes = isExclude ? includes : [...includes, text]
    const newExcludes = isExclude ? [...excludes, text] : excludes
    if (isExclude) setExcludes(newExcludes)
    else setIncludes(newIncludes)
    setSearch('')
    appendOutput(`${isExclude ? '❌' : '✅'} ${isExclude ? 'Exclude' : 'Include'}: "${text}"`, 'log')

    // Auto-query
    if (newIncludes.length > 0) {
      await runQuery(newIncludes, newExcludes)
    }
  }

  function removeCondition(text: string, type: 'include' | 'exclude') {
    const newIncludes = type === 'include' ? includes.filter(t => t !== text) : includes
    const newExcludes = type === 'exclude' ? excludes.filter(t => t !== text) : excludes
    if (type === 'include') setIncludes(newIncludes)
    else setExcludes(newExcludes)

    if (newIncludes.length > 0) {
      runQuery(newIncludes, newExcludes)
    } else {
      setResults(null)
    }
  }

  function clearConditions() {
    setIncludes([]); setExcludes([]); setResults(null)
  }

  // Test a selector — show children text as inline preview in wizard
  async function testSelector(selector: string) {
    try {
      const expr = `(() => {
        const parent = document.querySelector(${JSON.stringify(selector)});
        if (!parent) return JSON.stringify({ error: 'Not found' });
        const children = [...parent.children];
        const rendered = children.filter(c => (c.innerText || '').trim().length > 0);
        return JSON.stringify({
          parentTag: parent.tagName.toLowerCase(),
          childCount: children.length,
          renderedCount: rendered.length,
          rect: { w: Math.round(parent.getBoundingClientRect().width), h: Math.round(parent.getBoundingClientRect().height) },
          items: rendered.slice(0, 30).map((el, i) => {
            const text = (el.innerText || el.textContent || '').trim();
            return {
              index: i,
              tag: el.tagName.toLowerCase(),
              cls: (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join(' ') : '',
              text: text.substring(0, 200),
              childCount: el.children.length,
              h: Math.round(el.getBoundingClientRect().height),
            };
          })
        });
      })()`
      const raw = await api.evaluate(expr, ideTarget || undefined, 5000) as any
      const result = typeof raw?.result === 'string' ? JSON.parse(raw.result) : raw?.result
      if (result?.error) {
        appendOutput('❌ ' + result.error, 'error')
        return
      }
      setPreview({ selector, items: result.items || [] })
      const info = result.renderedCount < result.childCount
        ? `${result.childCount} total, ${result.renderedCount} rendered (virtual scroll)`
        : `${result.childCount} children`
      appendOutput(`▶ ${selector}: ${info}`, 'result')
    } catch (err: any) { appendOutput('Test failed: ' + err.message, 'error') }
  }

  return {
    search, setSearch, includes, excludes, results, preview, setPreview, searching,
    addCondition, removeCondition, clearConditions, testSelector,
  }
}

export type WizardController = ReturnType<typeof useWizard>
