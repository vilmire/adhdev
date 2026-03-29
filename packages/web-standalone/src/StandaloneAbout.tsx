/**
 * StandaloneAbout — Self-hosted About page
 *
 * Shows what the standalone version includes, what Cloud adds,
 * and a gentle nudge toward the cloud offering.
 */

const SELFHOST_FEATURES = [
    { icon: '🏠', title: 'Local-first', desc: 'Everything runs on your machine. No data leaves your network. Full privacy by design.' },
    { icon: '💬', title: 'Agent chat relay', desc: 'Read and respond to AI conversations in real-time across all connected IDEs.' },
    { icon: '📸', title: 'Live screenshots', desc: 'View your IDE screens directly in the browser via local WebSocket streaming.' },
    { icon: '🎛️', title: 'Remote control', desc: 'Click, type, and interact with your IDE from the dashboard — no window switching.' },
    { icon: '🔌', title: 'Multi-IDE support', desc: 'Monitor and control multiple IDEs simultaneously — VS Code, Cursor, Windsurf, and more.' },
    { icon: '⚡', title: 'Extension agents', desc: 'Manage extension-based agents like Cline and Roo Code alongside native IDE agents.' },
]

const CLOUD_EXTRAS = [
    { icon: '🌍', title: 'Access from anywhere', desc: 'Control your agents from any device, any network. No VPN or port forwarding needed.' },
    { icon: '🔗', title: 'WebRTC P2P streaming', desc: 'End-to-end encrypted peer-to-peer connection for zero-latency remote screenshots and control.' },
    { icon: '📱', title: 'Mobile notifications', desc: 'Get push notifications when agents need approval. Quick approve/reject from your phone.' },
    { icon: '📡', title: 'REST API access', desc: 'Integrate with Slack, CI/CD pipelines, or custom tools. Scoped API keys with granular permissions.' },
    { icon: '👥', title: 'Team dashboard', desc: 'Share a unified view across your team. See who\'s running what, where, in real time.' },
    { icon: '🔐', title: 'Enterprise security', desc: 'SSO, RBAC, audit logs, and SLA guarantees for production teams.' },
]

const COMPARISON = [
    { feature: 'Agent chat relay', selfhost: true, cloud: true },
    { feature: 'Live IDE screenshots', selfhost: true, cloud: true },
    { feature: 'Remote IDE control', selfhost: true, cloud: true },
    { feature: 'Multi-IDE monitoring', selfhost: true, cloud: true },
    { feature: 'Extension agent support', selfhost: true, cloud: true },
    { feature: 'CLI agent support', selfhost: true, cloud: true },
    { feature: 'Access from any network', selfhost: false, cloud: true },
    { feature: 'WebRTC P2P streaming', selfhost: false, cloud: true },
    { feature: 'Mobile push notifications', selfhost: false, cloud: true },
    { feature: 'REST API & webhooks', selfhost: false, cloud: true },
    { feature: 'Team collaboration', selfhost: false, cloud: true },
    { feature: 'Multi-machine (Burrows)', selfhost: false, cloud: true },
    { feature: 'SSO / RBAC / Audit logs', selfhost: false, cloud: true },
]

const SUPPORTED = {
    ides: ['VS Code', 'Cursor', 'Antigravity', 'Windsurf', 'Trae', 'PearAI', 'Kiro', 'VSCodium', 'VS Code Insiders'],
    agents: ['GitHub Copilot', 'Cline', 'Roo Code'],
    cli: ['Gemini CLI', 'Claude Code', 'Codex CLI'],
}

export default function StandaloneAbout() {
    return (
        <div className="py-8 px-6 max-w-[860px] mx-auto text-text-primary">
            {/* Header */}
            <div className="text-center mb-10">
                <img src="/otter-logo.png" alt="ADHDev" className="w-14 h-14 mb-3 mx-auto" />
                <h1 className="text-[26px] font-extrabold mb-1.5 text-text-primary">ADHDev</h1>
                <p className="text-[13px] text-text-muted">
                    Agent Dashboard Hub for Dev — Self-hosted Edition
                </p>
                <div className="inline-block mt-3 px-3 py-1 text-[11px] font-semibold tracking-wide rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                    SELFHOST v{__APP_VERSION__}
                </div>
            </div>

            {/* What's Included */}
            <section className="mb-10">
                <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <span className="text-base">✅</span> What's included
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
                    {SELFHOST_FEATURES.map(f => (
                        <div key={f.title} className="bg-bg-glass border border-border-subtle rounded-xl px-4 py-4 transition-colors hover:border-border-default">
                            <div className="text-xl mb-1.5">{f.icon}</div>
                            <div className="font-semibold text-[13px] mb-1">{f.title}</div>
                            <div className="text-[12px] text-text-muted leading-relaxed">{f.desc}</div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Works With */}
            <section className="mb-10">
                <h2 className="text-lg font-bold mb-4">Compatible with</h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-5">
                    {[
                        { label: 'IDEs', items: SUPPORTED.ides },
                        { label: 'Extension agents', items: SUPPORTED.agents },
                        { label: 'CLI agents', items: SUPPORTED.cli },
                    ].map(group => (
                        <div key={group.label}>
                            <div className="text-[10px] font-bold tracking-wider text-text-muted mb-2 uppercase">{group.label}</div>
                            <div className="flex flex-col gap-1">
                                {group.items.map(item => (
                                    <div key={item} className="text-[12px] px-2.5 py-1.5 bg-bg-glass rounded-md border border-border-subtle">{item}</div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Comparison Table */}
            <section className="mb-10">
                <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <span className="text-base">⚖️</span> Self-hosted vs Cloud
                </h2>
                <div className="rounded-xl border border-border-subtle overflow-hidden">
                    <table className="w-full text-[13px]">
                        <thead>
                            <tr className="bg-bg-secondary">
                                <th className="text-left px-4 py-2.5 font-semibold text-text-muted text-[11px] uppercase tracking-wider">Feature</th>
                                <th className="text-center px-4 py-2.5 font-semibold text-text-muted text-[11px] uppercase tracking-wider w-[100px]">Selfhost</th>
                                <th className="text-center px-4 py-2.5 font-semibold text-[11px] uppercase tracking-wider w-[100px] text-violet-500">Cloud</th>
                            </tr>
                        </thead>
                        <tbody>
                            {COMPARISON.map((row, i) => (
                                <tr key={row.feature} className={i % 2 === 0 ? 'bg-bg-glass' : ''}>
                                    <td className="px-4 py-2 text-text-secondary">{row.feature}</td>
                                    <td className="text-center px-4 py-2">
                                        {row.selfhost
                                            ? <span className="text-emerald-500">✓</span>
                                            : <span className="text-text-muted opacity-40">—</span>
                                        }
                                    </td>
                                    <td className="text-center px-4 py-2">
                                        <span className="text-emerald-500">✓</span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Cloud Upgrade CTA */}
            <section className="mb-10">
                <div className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] px-6 py-6">
                    <div className="flex items-start gap-4">
                        <div className="text-3xl shrink-0">🚀</div>
                        <div className="flex-1">
                            <h3 className="font-bold text-[15px] mb-1.5">Unlock more with ADHDev Cloud</h3>
                            <p className="text-[13px] text-text-muted leading-relaxed mb-4">
                                Access your agents from anywhere — your phone, another laptop, or a coffee shop.
                                Cloud adds WebRTC P2P streaming, mobile push notifications, REST API, team collaboration,
                                and multi-machine support. Your local setup stays exactly the same.
                            </p>
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5 mb-5">
                                {CLOUD_EXTRAS.map(f => (
                                    <div key={f.title} className="flex gap-2.5 items-start">
                                        <span className="text-base shrink-0 mt-0.5">{f.icon}</span>
                                        <div>
                                            <div className="font-semibold text-[12px]">{f.title}</div>
                                            <div className="text-[11px] text-text-muted leading-snug">{f.desc}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="flex gap-3 flex-wrap">
                                <a
                                    href="https://adhf.dev"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-primary btn-sm inline-flex items-center gap-1.5 no-underline"
                                >
                                    Try ADHDev Cloud →
                                </a>
                                <a
                                    href="https://github.com/vilmire/adhdev"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-secondary btn-sm inline-flex items-center gap-1.5 no-underline"
                                >
                                    GitHub
                                </a>
                                <a
                                    href="https://discord.gg/WJD3tCfBzk"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-secondary btn-sm inline-flex items-center gap-1.5 no-underline"
                                >
                                    Discord
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <div className="text-center text-xs text-text-muted pt-4 border-t border-border-subtle">
                <p>© 2026 RacoLab · ADHDev, Your AI sidekick otter 🦦</p>
                <p className="mt-1 opacity-60">Self-hosted edition — all data stays on your machine</p>
            </div>
        </div>
    )
}
