/**
 * InstallCommand — OS-aware install command block
 *
 * Detects the user's platform and shows the appropriate install command.
 * macOS/Linux: curl | sh
 * Windows: PowerShell (irm | iex) or CMD
 */
import { useState, useEffect, useCallback } from 'react'

type ShellType = 'unix' | 'powershell' | 'cmd'
type PlatformTab = 'unix' | 'windows'

const INSTALL_COMMANDS: Record<ShellType, { cmd: string; shell: string; prompt: string }> = {
    unix: { cmd: 'curl -fsSL https://adhf.dev/install | sh', shell: 'Terminal', prompt: '$ ' },
    powershell: { cmd: 'irm https://adhf.dev/install.ps1 | iex', shell: 'PowerShell', prompt: 'PS> ' },
    cmd: { cmd: 'curl -fsSL https://adhf.dev/install.cmd -o %TEMP%\\adhdev.cmd && %TEMP%\\adhdev.cmd', shell: 'CMD', prompt: '> ' },
}

function detectPlatform(): PlatformTab {
    if (typeof navigator === 'undefined') return 'unix'
    return navigator.userAgent.toLowerCase().includes('win') ? 'windows' : 'unix'
}

export default function InstallCommand() {
    const [platform, setPlatform] = useState<PlatformTab>('unix')
    const [winShell, setWinShell] = useState<'powershell' | 'cmd'>('powershell')
    const [copied, setCopied] = useState(false)
    const shell: ShellType = platform === 'unix' ? 'unix' : winShell

    useEffect(() => { setPlatform(detectPlatform()) }, [])

    const copyCommand = useCallback(() => {
        navigator.clipboard.writeText(INSTALL_COMMANDS[shell].cmd).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [shell])

    return (
        <div className="text-left bg-bg-secondary border border-border-subtle rounded-xl p-4 font-mono text-[13px] shadow-lg w-full mx-auto leading-relaxed relative select-all">
            {/* OS Tabs */}
            <div className="flex gap-1 mb-3 font-sans">
                <button
                    className={`text-[10px] px-2.5 py-1 rounded-md font-bold transition-all cursor-pointer ${
                        platform === 'unix'
                            ? 'bg-accent/15 text-accent border border-accent/25'
                            : 'bg-transparent text-text-muted border border-transparent hover:text-text-secondary'
                    }`}
                    onClick={() => setPlatform('unix')}
                >
                    🍎🐧 macOS / Linux
                </button>
                <button
                    className={`text-[10px] px-2.5 py-1 rounded-md font-bold transition-all cursor-pointer ${
                        platform === 'windows'
                            ? 'bg-accent/15 text-accent border border-accent/25'
                            : 'bg-transparent text-text-muted border border-transparent hover:text-text-secondary'
                    }`}
                    onClick={() => setPlatform('windows')}
                >
                    🪟 Windows
                </button>
            </div>

            {/* Windows sub-tabs */}
            {platform === 'windows' && (
                <div className="flex gap-1 mb-3 font-sans">
                    <button
                        className={`text-[9px] px-2 py-0.5 rounded font-semibold cursor-pointer transition-all ${
                            winShell === 'powershell' ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-secondary'
                        }`}
                        onClick={() => setWinShell('powershell')}
                    >⚡ PowerShell</button>
                    <button
                        className={`text-[9px] px-2 py-0.5 rounded font-semibold cursor-pointer transition-all ${
                            winShell === 'cmd' ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-secondary'
                        }`}
                        onClick={() => setWinShell('cmd')}
                    >&gt;_ CMD</button>
                </div>
            )}

            {/* Command */}
            <div
                className="flex items-center gap-3 text-accent cursor-pointer group"
                onClick={copyCommand}
                title="Click to copy"
            >
                <span className="text-text-muted select-none">{INSTALL_COMMANDS[shell].prompt}</span>
                <span className="flex-1 break-all">{INSTALL_COMMANDS[shell].cmd}</span>
                <span className="text-[9px] font-sans text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0 select-none">
                    {copied ? '✓' : '📋'}
                </span>
            </div>

            {/* npm fallback */}
            <div className="text-text-muted text-[10px] font-sans mt-2">
                Or via npm: <span className="text-text-secondary font-mono">npm i -g adhdev && adhdev setup</span>
            </div>
        </div>
    )
}
