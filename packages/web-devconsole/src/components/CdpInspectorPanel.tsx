import type { RefObject } from 'react'
import type { WizardController } from '../hooks/useWizard'
import { WizardView } from './WizardView'

export type InspectorTab = 'inspector' | 'analyze' | 'wizard'

/**
 * CDP (IDE / extension) right panel: the screenshot with click-to-inspect,
 * the CSS selector query bar, and the Inspector / Analyze / Wizard tabs.
 * Presentational — every piece of state is owned by App or useWizard.
 */
export function CdpInspectorPanel(props: {
  screenshotUrl: string | null
  imgRef: RefObject<HTMLImageElement>
  handleScreenshotClick: (e: React.MouseEvent<HTMLImageElement>) => void
  crosshair: { x: number; y: number } | null
  selectorInput: string
  setSelectorInput: (v: string) => void
  querySel: () => void
  selectorCount: string
  rightTab: InspectorTab
  setRightTab: (tab: InspectorTab) => void
  inspectResult: any
  analyzeResult: any
  copySel: (selector: string) => void
  analyzeElement: (selector?: string) => void
  insertSelectorCode: (selector: string) => void
  wizard: WizardController
}) {
  const {
    screenshotUrl, imgRef, handleScreenshotClick, crosshair, selectorInput, setSelectorInput, querySel,
    selectorCount, rightTab, setRightTab, inspectResult, analyzeResult, copySel, analyzeElement, insertSelectorCode, wizard,
  } = props
  return (
    <>
          <div className="screenshot-panel" id="screenshotPanel">
            {screenshotUrl ? (
              <>
                <img ref={imgRef} src={screenshotUrl} onClick={handleScreenshotClick} alt="IDE Screenshot" />
                {crosshair && <div className="crosshair" style={{ left: crosshair.x, top: crosshair.y }} />}
              </>
            ) : (
              <div className="placeholder">
                Click 📸 to capture IDE<br />
                <small>Then click on screenshot to inspect elements</small>
              </div>
            )}
          </div>
          <div className="selector-bar">
            <input value={selectorInput} onChange={e => setSelectorInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && querySel()} placeholder="CSS selector to test..." />
            <button onClick={querySel}>Query</button>
            <span className="count">{selectorCount}</span>
          </div>

          {/* Inspector / Analyzer / Wizard Tabs */}
          <div className="inspect-tabs">
            <button className={rightTab === 'inspector' ? 'active' : ''} onClick={() => setRightTab('inspector')}>🌳 Inspector</button>
            <button className={rightTab === 'analyze' ? 'active' : ''} onClick={() => setRightTab('analyze')}>🔬 Analyze</button>
            <button className={rightTab === 'wizard' ? 'active' : ''} onClick={() => setRightTab('wizard')}>🧙 Wizard</button>
          </div>

          {/* Inspector Tree */}
          {rightTab === 'inspector' && inspectResult && (
            <div className="dom-tree">
              {/* Ancestors */}
              {inspectResult.ancestors?.map((a: any, i: number) => (
                <div key={i} className="tree-node ancestor" style={{ paddingLeft: i * 12 + 4 }}>
                  <span className="tree-tag">&lt;{a.tag}&gt;</span>
                  {a.cls?.length > 0 && <span className="tree-cls">.{a.cls.join('.')}</span>}
                  <button className="tree-copy" onClick={() => copySel(a.selector)} title="Copy selector">📋</button>
                </div>
              ))}
              {/* Current element */}
              <div className="tree-node current" style={{ paddingLeft: (inspectResult.ancestors?.length || 0) * 12 + 4 }}>
                <span className="tree-tag">&lt;{inspectResult.element?.tag}&gt;</span>
                {inspectResult.element?.cls?.length > 0 && <span className="tree-cls">.{inspectResult.element.cls.join('.')}</span>}
                {inspectResult.element?.rect && <span className="tree-size">{inspectResult.element.rect.w}×{inspectResult.element.rect.h}</span>}
                <button className="tree-copy" onClick={() => copySel(inspectResult.element?.fullSelector || '')} title="Copy full selector">📋</button>
                {inspectResult.element?.directText && (
                  <div className="tree-text">"{inspectResult.element.directText.substring(0, 60)}"</div>
                )}
              </div>
              {/* Children */}
              {inspectResult.children?.slice(0, 15).map((c: any, i: number) => (
                <div key={i} className="tree-node child" style={{ paddingLeft: ((inspectResult.ancestors?.length || 0) + 1) * 12 + 4 }}>
                  <span className="tree-tag">&lt;{c.tag}&gt;</span>
                  {c.cls?.length > 0 && <span className="tree-cls">.{c.cls.slice(0, 2).join('.')}</span>}
                  {c.childCount > 0 && <span className="tree-count">({c.childCount})</span>}
                  <button className="tree-copy" onClick={() => copySel(c.selector)} title="Copy selector">📋</button>
                  {c.directText && <span className="tree-inline-text">{c.directText.substring(0, 40)}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Analyze Results — element-focused */}
          {rightTab === 'analyze' && analyzeResult && !analyzeResult.error && (
            <div className="analyze-results">
              {/* Target */}
              <div className="analyze-section">
                <div className="analyze-title">🎯 Target</div>
                <div className="analyze-item">
                  <div className="analyze-sel">
                    <code>{analyzeResult.target?.selector}</code>
                    <button className="tree-copy" onClick={() => copySel(analyzeResult.target?.selector || '')}>📋</button>
                  </div>
                  {analyzeResult.target?.text && <div className="analyze-sample">"{analyzeResult.target.text.substring(0, 100)}"</div>}
                </div>
              </div>

              {/* Sibling Pattern */}
              {analyzeResult.siblingPattern && (
                <div className="analyze-section">
                  <div className="analyze-title">🔁 Sibling Pattern — {analyzeResult.siblingPattern.count} matches (depth {analyzeResult.siblingPattern.depthFromTarget})</div>
                  <div className="analyze-item">
                    <div className="analyze-sel">
                      <code>{analyzeResult.siblingPattern.selector}</code>
                      <button className="tree-copy" onClick={() => copySel(analyzeResult.siblingPattern.selector)}>📋</button>
                    </div>
                  </div>
                  {/* Common/varying attrs */}
                  {Object.keys(analyzeResult.siblingPattern.varyingAttrs || {}).length > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', padding: '2px 8px' }}>
                      Varying: {Object.entries(analyzeResult.siblingPattern.varyingAttrs).map(([k, v]) =>
                        `${k}=[${(v as string[]).slice(0, 3).join(', ')}${(v as string[]).length > 3 ? '...' : ''}]`
                      ).join(', ')}
                    </div>
                  )}
                  {/* Sibling texts */}
                  {analyzeResult.siblingPattern.siblings?.slice(0, 15).map((s: any, i: number) => (
                    <div key={i} className="analyze-item" style={{ paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <span style={{ color: 'var(--text-dim)', fontSize: 10, minWidth: 20 }}>#{s.index}</span>
                        <span style={{ color: '#e5c07b', fontSize: 10 }}>&lt;{s.tag}&gt;</span>
                        {s.childCount > 0 && <span className="tree-count">({s.childCount})</span>}
                      </div>
                      {s.allText && <div className="analyze-sample" style={{ paddingLeft: 24 }}>"{s.allText.substring(0, 120)}"</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* Ancestor Analysis */}
              {analyzeResult.ancestorAnalysis?.length > 0 && (
                <div className="analyze-section">
                  <div className="analyze-title">⬆️ Ancestor Chain</div>
                  {analyzeResult.ancestorAnalysis.map((a: any, i: number) => (
                    <div key={i} className="analyze-item" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ color: 'var(--text-dim)', fontSize: 10, minWidth: 14 }}>↑{a.depth}</span>
                      <code style={{ fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.fullSelector}</code>
                      <span style={{ color: a.matchingSiblings >= 3 ? 'var(--accent-green)' : 'var(--text-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>
                        {a.matchingSiblings}/{a.totalChildren}
                      </span>
                      {a.matchingSiblings >= 3 && (
                        <button className="tree-copy" onClick={() => { copySel(a.fullSelector); analyzeElement(a.fullSelector); }} title="Analyze this level"
                          style={{ fontSize: 10, opacity: 0.7, background: 'none', border: 'none', cursor: 'pointer' }}>🔬</button>
                      )}
                      <button className="tree-copy" onClick={() => copySel(a.fullSelector)}>📋</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Subtree Texts */}
              {analyzeResult.subtreeTexts?.length > 0 && (
                <div className="analyze-section">
                  <div className="analyze-title">📝 Text Nodes ({analyzeResult.subtreeTexts.length})</div>
                  {analyzeResult.subtreeTexts.slice(0, 15).map((t: any, i: number) => (
                    <div key={i} className="analyze-item" style={{ display: 'flex', gap: 4 }}>
                      <span className="tree-tag" style={{ fontSize: 10 }}>&lt;{t.parentTag}&gt;</span>
                      <span className="analyze-sample" style={{ flex: 1, paddingLeft: 0 }}>"{t.text}"</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {rightTab === 'inspector' && !inspectResult && (
            <div className="placeholder" style={{ padding: 20 }}>
              Click on screenshot to inspect DOM elements
            </div>
          )}
          {rightTab === 'analyze' && !analyzeResult && (
            <div className="placeholder" style={{ padding: 20 }}>
              Click an element first, then 🔬 Analyze
            </div>
          )}

          {/* Wizard Tab */}
          {rightTab === 'wizard' && <WizardView wizard={wizard} copySel={copySel} insertSelectorCode={insertSelectorCode} />}
    </>
  )
}
