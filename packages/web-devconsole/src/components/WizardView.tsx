import type { WizardController } from '../hooks/useWizard'

/** The Wizard tab: include/exclude text conditions → common-ancestor selector candidates. */
export function WizardView({ wizard, copySel, insertSelectorCode }: {
  wizard: WizardController
  copySel: (selector: string) => void
  insertSelectorCode: (selector: string) => void
}) {
  return (
    <div className="analyze-results">
      {/* Condition Builder */}
      <div className="analyze-section">
        <div className="analyze-title">🧙 Selector Finder</div>

        {/* Condition tags */}
        {(wizard.includes.length > 0 || wizard.excludes.length > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '3px 0' }}>
            {wizard.includes.map((t, i) => (
              <span key={'i' + i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '1px 6px', borderRadius: 8, fontSize: 10,
                background: 'rgba(152,195,121,0.15)', color: 'var(--accent-green)',
                border: '1px solid rgba(152,195,121,0.3)',
              }}>
                ✓ {t}
                <button onClick={() => wizard.removeCondition(t, 'include')} style={{
                  background: 'none', border: 'none', color: 'var(--accent-green)', 
                  cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1,
                }}>×</button>
              </span>
            ))}
            {wizard.excludes.map((t, i) => (
              <span key={'e' + i} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '1px 6px', borderRadius: 8, fontSize: 10,
                background: 'rgba(224,108,117,0.15)', color: '#e06c75',
                border: '1px solid rgba(224,108,117,0.3)',
              }}>
                ✗ {t}
                <button onClick={() => wizard.removeCondition(t, 'exclude')} style={{
                  background: 'none', border: 'none', color: '#e06c75',
                  cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1,
                }}>×</button>
              </span>
            ))}
            <button onClick={() => { wizard.clearConditions(); }}
              style={{ fontSize: 9, padding: '0 4px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, cursor: 'pointer' }}>
              clear
            </button>
          </div>
        )}

        {/* Input */}
        <div style={{ display: 'flex', gap: 4, padding: '3px 0' }}>
          <input
            value={wizard.search}
            onChange={e => wizard.setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && wizard.addCondition()}
            placeholder="text to include, !text to exclude"
            style={{ flex: 1, background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', padding: '5px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }}
          />
          <button onClick={wizard.addCondition} disabled={wizard.searching} style={{ fontSize: 10, padding: '3px 8px' }}>
            {wizard.searching ? '⏳' : '+ Add'}
          </button>
        </div>
      </div>

      {/* Results */}
      {wizard.results?.results?.length > 0 && (
        <div className="analyze-section">
          <div className="analyze-title" style={{ color: 'var(--accent-green)' }}>
            Common Ancestors ({wizard.results.results.length})
            <span style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 400, marginLeft: 6 }}>
              lists first
            </span>
          </div>
          {wizard.results.results.slice(0, 10).map((r: any, i: number) => (
            <div key={i} className="analyze-item" style={{
              padding: '4px 0', borderBottom: '1px solid var(--border)',
              borderLeft: r.isList ? '2px solid var(--accent-green)' : 'none',
              paddingLeft: r.isList ? 6 : 0,
            }}>
              {/* Selector + meta */}
              <div className="analyze-sel">
                <code title={r.selector} style={{ fontSize: 9 }}>{r.selector}</code>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 9, color: 'var(--text-dim)', padding: '1px 0' }}>
                <span>&lt;{r.tag}&gt;</span>
                {r.isList && <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>📋 list: {r.listItemCount} items</span>}
                {!r.isList && <span>{r.childCount} children</span>}
                {r.placeholderCount > 0 && <span style={{ color: '#e5c07b' }}>👁 {r.renderedCount} visible</span>}
                <span>{r.rect.w}×{r.rect.h}</span>
              </div>

              {/* Virtual scroll notice */}
              {r.placeholderCount > 0 && r.renderedCount <= 3 && (
                <div style={{ fontSize: 8, color: '#e5c07b', padding: '2px 4px', background: 'rgba(229,192,123,0.1)', borderRadius: 3, marginTop: 2 }}>
                  ⚠ Virtual scroll: {r.listItemCount} total, only {r.renderedCount} rendered in DOM. Scroll to load more.
                </div>
              )}

              {/* Item text samples — show like readChat output */}
              {r.items?.length > 0 && (
                <div style={{ paddingLeft: 4, maxHeight: 100, overflow: 'auto' }}>
                  {r.items.slice(0, 8).map((item: any, ii: number) => (
                    <div key={ii} style={{ fontSize: 8, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--accent)', minWidth: 14, display: 'inline-block' }}>[{item.index}]</span>
                      <span style={{ color: '#e06c75' }}>&lt;{item.tag}&gt;</span> {item.text ? `"${item.text.substring(0, 100)}"` : '(empty)'}
                    </div>
                  ))}
                  {r.items.length > 8 && (
                    <div style={{ fontSize: 8, color: 'var(--text-dim)' }}>...{r.items.length - 8} more</div>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 4, paddingTop: 2 }}>
                <button onClick={() => wizard.testSelector(r.selector)}
                  style={{ fontSize: 9, padding: '1px 6px', background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--accent-green)', borderRadius: 3, cursor: 'pointer' }}>
                  ▶ Test
                </button>
                <button onClick={() => insertSelectorCode(r.selector)}
                  style={{ fontSize: 9, padding: '1px 6px', background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--accent)', borderRadius: 3, cursor: 'pointer' }}>
                  → Code
                </button>
                <button className="tree-copy" onClick={() => copySel(r.selector)} style={{ opacity: 0.7, fontSize: 9 }}>📋</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {wizard.includes.length === 1 && (!wizard.results || wizard.results?.results?.length === 0) && (
        <div className="analyze-section">
          <div className="analyze-title" style={{ color: 'var(--accent)' }}>➕ Add one more text</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            Add text from a <b>different item in the same list</b> to find the common container.<br/>
            e.g. text from another chat message, another menu item, etc.
          </div>
        </div>
      )}

      {wizard.results?.results?.length === 0 && wizard.includes.length >= 2 && (
        <div className="analyze-section">
          <div className="analyze-title">⚠️ No common ancestors found</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            The texts might be in completely different DOM areas. Try text from the same UI section.
          </div>
        </div>
      )}

      {/* Inline Preview — shows after ▶ Test */}
      {wizard.preview && (
        <div className="analyze-section" style={{ borderLeft: '2px solid var(--accent-green)' }}>
          <div className="analyze-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>📋 Preview: {wizard.preview.items.length} children</span>
            <button onClick={() => wizard.setPreview(null)}
              style={{ fontSize: 9, background: 'none', border: 'none', color: '#e06c75', cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ fontSize: 8, color: 'var(--text-dim)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {wizard.preview.selector}
          </div>
          <div style={{ maxHeight: 250, overflow: 'auto' }}>
            {wizard.preview.items.map((item: any, i: number) => (
              <div key={i} style={{
                padding: '2px 4px', fontSize: 9,
                borderBottom: '1px solid var(--border)',
                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
              }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--accent)', minWidth: 16 }}>[{item.index}]</span>
                  <span style={{ color: '#e06c75', minWidth: 30 }}>&lt;{item.tag}&gt;</span>
                  {item.cls && <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>.{item.cls.split(' ')[0]}</span>}
                  <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>{item.h}px</span>
                </div>
                <div style={{
                  color: 'var(--text)', paddingLeft: 16,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: '100%', fontSize: 9,
                }}>
                  {item.text ? `"${item.text.substring(0, 120)}"` : <span style={{ color: 'var(--text-dim)' }}>(empty)</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Guide */}
      {wizard.includes.length === 0 && wizard.excludes.length === 0 && (
        <div className="analyze-section">
          <div className="analyze-title">📖 How to Use</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.8 }}>
            <b>Include:</b> Type visible text → Enter<br/>
            <b>Exclude:</b> Prefix with <code>!</code> → Enter<br/><br/>
            <b>Example — find chat container:</b><br/>
            1. Add text from one message<br/>
            2. Add text from another message<br/>
            3. → Common Ancestors shows the chat container<br/>
            4. ▶ Test to verify, → Code to insert template
          </div>
        </div>
      )}
    </div>
  )
}
