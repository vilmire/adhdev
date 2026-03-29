import { PageHeader } from '../components/ui/PageHeader'
import { IconMonitor, IconTerminal, IconPlug, IconClock, IconWarning, IconShield, IconBook } from '../components/Icons'

const IDE_CAPABILITIES = [
    { name: 'Antigravity', status: 'Stable', details: 'Full CDP support' },
    { name: 'Cursor', status: 'Stable', details: 'Full CDP support' },
    { name: 'Windsurf', status: 'Stable', details: 'Full CDP support' },
    { name: 'Kiro', status: 'Stable', details: 'Webview CDP support' },
    { name: 'PearAI', status: 'Beta', details: 'Webview CDP support' },
    { name: 'Trae', status: 'Beta', details: 'Webview CDP support' },
    { name: 'VS Code', status: 'WIP', details: 'Infrastructure ready' },
    { name: 'VS Code Insiders', status: 'WIP', details: 'Infrastructure ready' },
    { name: 'VSCodium', status: 'WIP', details: 'Infrastructure ready' },
]

const CLI_CAPABILITIES = [
    { name: 'Claude Code', status: 'Stable', details: 'Terminal + Chat Mode' },
    { name: 'Codex CLI', status: 'Stable', details: 'Terminal + Chat Mode' },
    { name: 'Aider', status: 'Beta', details: 'Terminal only (Chat Mode WIP)' },
    { name: 'Cursor CLI', status: 'Beta', details: 'Terminal only (Chat Mode WIP)' },
    { name: 'Gemini CLI', status: 'Beta', details: 'Terminal only (Chat Mode WIP)' },
    { name: 'GitHub Copilot CLI', status: 'Beta', details: 'Terminal only (Chat Mode WIP)' },
    { name: 'Goose CLI', status: 'Beta', details: 'Terminal only (Chat Mode WIP)' },
    { name: 'OpenCode CLI', status: 'Beta', details: 'Terminal only (Chat Mode WIP)' },
]

const EXT_CAPABILITIES = [
    { name: 'Cline', status: 'Stable', details: 'Independent Stream' },
    { name: 'Roo Code (3.x, 4.x)', status: 'Stable', details: 'Independent Stream' },
    { name: 'Codex Extension', status: 'Stable', details: 'Independent Stream' },
    { name: 'Cursor Composer', status: 'Stable', details: 'Native agent mode integration' },
]

export default function CapabilitiesPage() {
    const renderStatus = (status: string) => {
        if (status === 'Stable') {
            return <div className="flex items-center gap-1.5 text-success"><IconShield className="w-4 h-4" /> <span>Stable</span></div>
        }
        if (status === 'Beta') {
            return <div className="flex items-center gap-1.5 text-warning"><IconWarning className="w-4 h-4" /> <span>Beta</span></div>
        }
        return <div className="flex items-center gap-1.5 text-text-muted"><IconClock className="w-4 h-4" /> <span>WIP</span></div>
    }

    const renderTable = (items: any[]) => (
        <div className="bg-bg-panel border border-border-card rounded-md overflow-hidden">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="bg-bg-subtle border-b border-border-card text-xs uppercase text-text-muted font-medium tracking-wider">
                        <th className="py-3 px-4 w-1/3">Target</th>
                        <th className="py-3 px-4 w-1/4">Status</th>
                        <th className="py-3 px-4">Details</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border-card text-sm">
                    {items.map((item, i) => (
                        <tr key={i} className="hover:bg-bg-subtle/50 transition-colors">
                            <td className="py-3 px-4 font-medium text-text-main">{item.name}</td>
                            <td className="py-3 px-4">{renderStatus(item.status)}</td>
                            <td className="py-3 px-4 text-text-muted">{item.details}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )

    return (
        <div className="p-8 max-w-4xl mx-auto animate-fade-in pb-20">
            <PageHeader
                title="Capabilities & Provider Status"
                subtitle="Support matrix for IDEs, CLI Agents, and AI Extensions"
                icon={<IconBook />}
            />

            <div className="space-y-12 mt-8">
                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-blue-500/10 text-blue-400">
                            <IconMonitor className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">IDE Support</h2>
                    </div>
                    {renderTable(IDE_CAPABILITIES)}
                </section>

                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-purple-500/10 text-purple-400">
                            <IconTerminal className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">Standalone CLI Agents</h2>
                    </div>
                    {renderTable(CLI_CAPABILITIES)}
                </section>

                <section>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="p-2 rounded-md bg-green-500/10 text-green-400">
                            <IconPlug className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-semibold text-text-main tracking-tight">AI Extensions</h2>
                    </div>
                    {renderTable(EXT_CAPABILITIES)}
                </section>
                
                <section>
                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-md p-4 flex gap-4">
                        <div className="mt-1 text-blue-400">
                            <IconPlug className="w-5 h-5" />
                        </div>
                        <div>
                            <h3 className="text-md font-semibold text-blue-400 mb-1">ACP Agents (Agent Client Protocol)</h3>
                            <p className="text-sm text-text-muted">
                                Over 35 ACP agents are currently supported including Gemini, Codex, Claude Agent, Cursor, Cline, GitHub Copilot, Goose, and many more. New ACP integration supports are added globally via Provider synchronization.
                            </p>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    )
}
