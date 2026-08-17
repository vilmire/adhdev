/**
 * StandaloneAbout — Self-hosted About page
 *
 * Shows what the standalone version includes, what Cloud adds,
 * and keeps the same section rhythm as the rest of the app.
 */
import { useTranslation } from 'react-i18next'
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
    Section,
    IconDiscord,
} from '@adhdev/web-core'

declare const __APP_VERSION__: string

// Card copy lives in i18n (standalone.about.features.*) — these arrays carry
// only the icon + key so every locale renders translated cards.
const SELFHOST_FEATURES = [
    { icon: <IconServer size={16} />, key: 'localFirst' },
    { icon: <IconChat size={16} />, key: 'chatRelay' },
    { icon: <IconEye size={16} />, key: 'screenshots' },
    { icon: <IconMonitor size={16} />, key: 'remoteControl' },
    { icon: <IconPlug size={16} />, key: 'multiIde' },
    { icon: <IconBook size={16} />, key: 'cliAcp' },
]

const CLOUD_EXTRAS = [
    { icon: <IconRocket size={16} />, key: 'anywhere' },
    { icon: <IconDashboard size={16} />, key: 'p2pStream' },
    { icon: <IconBell size={16} />, key: 'mobileNotifications' },
    { icon: <IconKey size={16} />, key: 'restApi' },
    { icon: <IconShield size={16} />, key: 'enterpriseControls' },
]

const COMPARISON = [
    { key: 'chatRelay', selfhost: true, cloud: true },
    { key: 'screenshots', selfhost: true, cloud: true },
    { key: 'remoteControl', selfhost: true, cloud: true },
    { key: 'multiIde', selfhost: true, cloud: true },
    { key: 'extensionCli', selfhost: true, cloud: true },
    { key: 'anyNetwork', selfhost: false, cloud: true },
    { key: 'webrtc', selfhost: false, cloud: true },
    { key: 'mobilePush', selfhost: false, cloud: true },
    { key: 'restApi', selfhost: false, cloud: true },
    { key: 'multiMachineDashboards', selfhost: false, cloud: true },
    { key: 'ssoRbacAuditLogs', selfhost: false, cloud: true },
]

export default function StandaloneAbout() {
    const { t } = useTranslation('common')
    return (
        <AppPage
            icon={<IconInfo className="text-text-primary" />}
            title={t('standalone.about.title')}
            subtitle={t('standalone.about.subtitle')}
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
                        <div className="text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-400 mb-2">{t('standalone.about.selfHostedEdition')}</div>
                        <h2 className="text-2xl font-semibold tracking-tight text-text-primary mb-2">{t('standalone.about.headline')}</h2>
                        <p className="text-sm text-text-muted leading-relaxed">
                            {t('standalone.about.description')}
                        </p>
                    </div>
                    <div className="grid gap-2 min-w-[220px]">
                        <a href="https://docs.adhf.dev" target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm inline-flex justify-center no-underline">{t('standalone.about.docs')}</a>
                        <a href="https://github.com/vilmire/adhdev" target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm inline-flex justify-center no-underline">{t('standalone.about.github')}</a>
                        <a href="https://adhf.dev" target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm inline-flex justify-center no-underline">{t('standalone.about.tryCloud')}</a>
                    </div>
                </div>
            </Section>

            <Section title={t('standalone.about.includedSection')} description={t('standalone.about.includedDescription')}>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {SELFHOST_FEATURES.map(feature => (
                        <div key={feature.key} className="rounded-xl border border-border-subtle bg-bg-glass px-4 py-4 transition-colors hover:border-border-default">
                            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
                                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-secondary text-text-secondary border border-border-subtle">
                                    {feature.icon}
                                </span>
                                {t('standalone.about.features.' + feature.key + '.title')}
                            </div>
                            <p className="text-[13px] leading-relaxed text-text-muted">{t('standalone.about.features.' + feature.key + '.desc')}</p>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title={t('standalone.about.inventorySection')} description={t('standalone.about.inventoryDescription')}>
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

            <Section title={t('standalone.about.cloudExtrasSection')} description={t('standalone.about.cloudExtrasDescription')}>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {CLOUD_EXTRAS.map(feature => (
                        <div key={feature.key} className="rounded-xl border border-accent-primary/20 bg-accent-primary/5 px-4 py-4">
                            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
                                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                                    {feature.icon}
                                </span>
                                {t('standalone.about.extras.' + feature.key + '.title')}
                            </div>
                            <p className="text-[13px] leading-relaxed text-text-muted">{t('standalone.about.extras.' + feature.key + '.desc')}</p>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title={t('standalone.about.comparisonSection')} description={t('standalone.about.comparisonDescription')}>
                <div className="overflow-x-auto rounded-xl border border-border-subtle">
                    <table className="w-full text-[13px]">
                        <thead>
                            <tr className="bg-bg-secondary">
                                <th className="text-left px-4 py-3 font-semibold text-text-muted text-[11px] uppercase tracking-wider">{t('standalone.about.featureHeader')}</th>
                                <th className="text-center px-4 py-3 font-semibold text-text-muted text-[11px] uppercase tracking-wider w-[110px]">{t('standalone.about.selfhostHeader')}</th>
                                <th className="text-center px-4 py-3 font-semibold text-accent-primary text-[11px] uppercase tracking-wider w-[110px]">{t('standalone.about.cloudHeader')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {COMPARISON.map((row, index) => (
                                <tr key={row.key} className={index % 2 === 0 ? 'bg-bg-glass' : 'bg-transparent'}>
                                    <td className="px-4 py-2.5 text-text-secondary">{t('standalone.about.comparison.' + row.key)}</td>
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
                title={t('standalone.about.cloudOptional')}
                description={t('standalone.about.cloudOptionalDescription')}
                action={(
                    <div className="flex flex-wrap justify-center gap-3">
                        <a href="https://adhf.dev" target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm no-underline">{t('standalone.about.compareCloud')}</a>
                        <a href="https://discord.gg/WJD3tCfBzk" target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm no-underline"><IconDiscord size={14} className="mr-1" />{t('standalone.about.discord')}</a>
                    </div>
                )}
            />
        </AppPage>
    )
}
