/**
 * StandaloneAbout — Self-hosted About page
 *
 * Shows what the standalone version includes, what Cloud adds,
 * and keeps the same section rhythm as the rest of the app.
 */
import {
    AppPage,
    BUILTIN_CLI_AGENTS,
    BUILTIN_EXTENSIONS,
    BUILTIN_IDES,
    EmptyState,
    IconBell,
    IconBook,
    IconChat,
    IconDashboard,
    IconEye,
    IconInfo,
    IconKey,
    IconMonitor,
    IconPlug,
    IconRocket,
    IconServer,
    IconShield,
    IconUsers,
    Section,
    IconDiscord,
} from '@adhdev/web-core'

declare const __APP_VERSION__: string

const SELFHOST_FEATURES = [
    { icon: <IconServer size={16} />, title: 'Local-first runtime', desc: 'Everything stays on your machine and the browser only connects over localhost.' },
    { icon: <IconChat size={16} />, title: 'Agent chat relay', desc: 'Read and respond to AI conversations in real time across connected IDEs.' },
    { icon: <IconEye size={16} />, title: 'Live screenshots', desc: 'View your IDE directly in the browser through the local screenshot stream.' },
    { icon: <IconMonitor size={16} />, title: 'Remote control', desc: 'Click, type, and steer your IDE sessions without switching windows.' },
    { icon: <IconPlug size={16} />, title: 'Multi-IDE support', desc: 'Monitor VS Code, Cursor, Windsurf, and extension-based agents in one place.' },
    { icon: <IconBook size={16} />, title: 'CLI and ACP coverage', desc: 'Track standalone CLI agents and ACP-backed workflows alongside IDE sessions.' },
]

const CLOUD_EXTRAS = [
    { icon: <IconRocket size={16} />, title: 'Access from anywhere', desc: 'Reach your burrows from another laptop or phone without opening local ports.' },
    { icon: <IconDashboard size={16} />, title: 'Low-latency P2P stream', desc: 'Cloud adds the WebRTC path for faster screenshots and remote control.' },
    { icon: <IconBell size={16} />, title: 'Mobile notifications', desc: 'Get approval prompts and activity updates when you are away from your desk.' },
    { icon: <IconKey size={16} />, title: 'REST API access', desc: 'Integrate with Slack, CI, or internal tools using API keys and service routes.' },
    { icon: <IconUsers size={16} />, title: 'Team workspace', desc: 'Share burrows, activity views, and policies across a team workspace.' },
    { icon: <IconShield size={16} />, title: 'Enterprise controls', desc: 'SSO, RBAC, audit logs, and managed policy features for production teams.' },
]

const COMPARISON = [
    { feature: 'Agent chat relay', selfhost: true, cloud: true },
    { feature: 'Live IDE screenshots', selfhost: true, cloud: true },
    { feature: 'Remote IDE control', selfhost: true, cloud: true },
    { feature: 'Multi-IDE monitoring', selfhost: true, cloud: true },
    { feature: 'Extension and CLI agents', selfhost: true, cloud: true },
    { feature: 'Access from any network', selfhost: false, cloud: true },
    { feature: 'WebRTC P2P streaming', selfhost: false, cloud: true },
    { feature: 'Mobile push notifications', selfhost: false, cloud: true },
    { feature: 'REST API and webhooks', selfhost: false, cloud: true },
    { feature: 'Team collaboration', selfhost: false, cloud: true },
    { feature: 'Multi-machine burrows', selfhost: false, cloud: true },
    { feature: 'SSO, RBAC, audit logs', selfhost: false, cloud: true },
]

export default function StandaloneAbout() {
    return (
        <AppPage
            icon={<IconInfo className="text-text-primary" />}
            title="About"
            subtitle="Self-hosted ADHDev overview, built-in surfaces, and what changes in Cloud"
            widthClassName="max-w-5xl"
            actions={(
                <div className="px-3 py-1 text-[11px] font-semibold tracking-wide rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                    SELFHOST v{__APP_VERSION__}
                </div>
            )}
        >
            <Section>
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="max-w-2xl">
                        <div className="text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-400 mb-2">Self-hosted edition</div>
                        <h2 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">Keep the same dashboard experience, with the runtime fully on-device.</h2>
                        <p className="text-sm text-text-muted leading-relaxed">
                            Standalone keeps the browser, daemon, screenshots, and control path on your own machine. It is the same core product shape as cloud, just without the remote networking and team layers.
                        </p>
                    </div>
                    <div className="grid gap-2 min-w-[220px]">
                        <a href="https://docs.adhf.dev" target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm inline-flex justify-center no-underline">Docs ↗</a>
                        <a href="https://github.com/vilmire/adhdev" target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm inline-flex justify-center no-underline">GitHub ↗</a>
                        <a href="https://adhf.dev" target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm inline-flex justify-center no-underline">Try Cloud ↗</a>
                    </div>
                </div>
            </Section>

            <Section title="Included in standalone" description="The local-first feature set available without the cloud control plane.">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {SELFHOST_FEATURES.map(feature => (
                        <div key={feature.title} className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-4 transition-colors hover:border-border-default">
                            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
                                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-secondary text-text-secondary border border-border-subtle">
                                    {feature.icon}
                                </span>
                                {feature.title}
                            </div>
                            <p className="text-[13px] leading-relaxed text-text-muted">{feature.desc}</p>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title="Built-in inventory" description="Bundled editors and agent surfaces exposed in the standalone dashboard. These lists describe inventory, not verified support.">
                <div className="grid gap-4 md:grid-cols-3">
                    {[
                        { label: 'IDEs', items: BUILTIN_IDES.map(item => `${item.icon} ${item.name}`) },
                        { label: 'Extensions', items: BUILTIN_EXTENSIONS.map(item => `${item.icon} ${item.name}`) },
                        { label: 'CLI agents', items: BUILTIN_CLI_AGENTS.map(item => `${item.icon} ${item.name}`) },
                    ].map(group => (
                        <div key={group.label} className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-4">
                            <div className="text-[11px] font-bold tracking-wider text-text-muted mb-3 uppercase">{group.label}</div>
                            <div className="flex flex-col gap-1.5">
                                {group.items.map(item => (
                                    <div key={item} className="rounded-md border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[12px] text-text-secondary">
                                        {item}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title="Cloud-only extras" description="Capabilities that need the hosted control plane or team infrastructure.">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {CLOUD_EXTRAS.map(feature => (
                        <div key={feature.title} className="rounded-xl border border-accent-primary/20 bg-accent-primary/5 px-4 py-4">
                            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
                                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                                    {feature.icon}
                                </span>
                                {feature.title}
                            </div>
                            <p className="text-[13px] leading-relaxed text-text-muted">{feature.desc}</p>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title="Self-hosted vs Cloud" description="The product split at a glance.">
                <div className="overflow-x-auto rounded-xl border border-border-subtle">
                    <table className="w-full text-[13px]">
                        <thead>
                            <tr className="bg-bg-secondary">
                                <th className="text-left px-4 py-3 font-semibold text-text-muted text-[11px] uppercase tracking-wider">Feature</th>
                                <th className="text-center px-4 py-3 font-semibold text-text-muted text-[11px] uppercase tracking-wider w-[110px]">Selfhost</th>
                                <th className="text-center px-4 py-3 font-semibold text-accent-primary text-[11px] uppercase tracking-wider w-[110px]">Cloud</th>
                            </tr>
                        </thead>
                        <tbody>
                            {COMPARISON.map((row, index) => (
                                <tr key={row.feature} className={index % 2 === 0 ? 'bg-bg-glass' : 'bg-transparent'}>
                                    <td className="px-4 py-2.5 text-text-secondary">{row.feature}</td>
                                    <td className="px-4 py-2.5 text-center">{row.selfhost ? <span className="text-emerald-500">✓</span> : <span className="text-text-muted opacity-40">—</span>}</td>
                                    <td className="px-4 py-2.5 text-center"><span className="text-emerald-500">✓</span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Section>

            <EmptyState
                icon={<img src="/otter-logo.png" alt="" className="mx-auto h-12 w-12 opacity-80" />}
                title="Cloud is optional, not required"
                description="You can stay fully local in standalone, and move to cloud later without changing how you use the dashboard."
                action={(
                    <div className="flex flex-wrap justify-center gap-3">
                        <a href="https://adhf.dev" target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm no-underline">Compare Cloud ↗</a>
                        <a href="https://discord.gg/WJD3tCfBzk" target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm no-underline"><IconDiscord size={14} className="mr-1" />Discord ↗</a>
                    </div>
                )}
            />
        </AppPage>
    )
}
