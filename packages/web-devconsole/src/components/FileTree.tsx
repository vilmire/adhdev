import type { ProviderInfo } from '../api'

export type FileEntry = { path: string; size: number; type: 'file' | 'dir' }

function formatSize(size: number): string {
  return size > 1024 ? (size / 1024).toFixed(1) + 'K' : size + 'B'
}

/** Editor sidebar: CDP provider scripts (run / run-with-params) and the provider's file tree. */
export function FileTree({ isCdp, selectedProvider, scriptHints, fileList, activeFile, runScript, openParamDialog, loadFile, onNewFile }: {
  isCdp: boolean
  selectedProvider: ProviderInfo | undefined
  scriptHints: Record<string, { template: Record<string, any>; description: string }>
  fileList: FileEntry[]
  activeFile: string | null
  runScript: (scriptName: string) => void
  openParamDialog: (scriptName: string) => void
  loadFile: (filePath: string) => void
  onNewFile: () => void
}) {
  return (
    <div className="file-tree">
      {/* Scripts Section */}
      {isCdp && (selectedProvider?.scripts || []).length > 0 && (
        <div className="ft-section">
          <div className="ft-section-header">⚡ SCRIPTS</div>
          {(selectedProvider?.scripts || []).map(s => (
            <div key={s} className={`ft-item ft-script`}>
              <span className="ft-name">{s}</span>
              <div className="ft-actions always">
                <button className="ft-run" onClick={() => runScript(s)} title="Run">▶</button>
                <button className="ft-params" onClick={() => openParamDialog(s)} title={scriptHints[s]?.description || 'Run with params'}>⚙</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Files Section */}
      <div className="ft-section">
        <div className="ft-section-header">
          📂 FILES
          <button className="ft-new-btn" onClick={onNewFile} title="New file">＋</button>
        </div>
        {fileList.length === 0 && <div className="ft-empty">No files found</div>}
        {/* Root files */}
        {fileList.filter(f => f.type === 'file' && !f.path.includes('/')).map(f => (
          <div key={f.path} className={`ft-item ${activeFile === f.path ? 'active' : ''}`} onClick={() => loadFile(f.path)}>
            <span className="ft-icon">{f.path.endsWith('.json') ? '📋' : '📄'}</span>
            <span className="ft-name">{f.path}</span>
            <span className="ft-size">{formatSize(f.size)}</span>
          </div>
        ))}
        {/* Grouped folders */}
        {[...new Set(fileList.filter(f => f.path.includes('/')).map(f => f.path.split('/')[0]))].map(folder => (
          <details key={folder} open>
            <summary className="ft-folder">📁 {folder}/</summary>
            {fileList.filter(f => f.type === 'file' && f.path.startsWith(folder + '/')).map(f => {
              const fileName = f.path.split('/').pop() || f.path
              return (
                <div key={f.path} className={`ft-item ft-nested ${activeFile === f.path ? 'active' : ''}`} onClick={() => loadFile(f.path)}>
                  <span className="ft-icon">📄</span>
                  <span className="ft-name">{fileName}</span>
                  <span className="ft-size">{formatSize(f.size)}</span>
                </div>
              )
            })}
          </details>
        ))}
      </div>
    </div>
  )
}
