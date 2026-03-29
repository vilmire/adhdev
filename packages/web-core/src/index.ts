/**
 * @adhdev/web-core — Shared components, hooks, type, API client
 *
 * Imported and used by web-standalone and downstream consumers.
 */

// ── Types ──
export type { DaemonData, BaseDaemonData, ChatMessage, ConnectionStatus } from './types'

// ── Context: Daemon State ──
export {
    BaseDaemonProvider,
    useBaseDaemons,
    useBaseDaemonActions,
    reconcileIdes,
    expandCompactDaemons,
} from './context/BaseDaemonContext'
export type {
    Toast,
    BaseDaemonContextValue,
    BaseDaemonActions,
    CompactDaemon,
    ConnectionOverrides,
} from './context/BaseDaemonContext'

// ── Context: API Client ──
export { ApiProvider, useApi } from './context/ApiContext'

// ── Context: Transport (P2P / HTTP abstraction) ──
export { TransportProvider, useTransport } from './context/TransportContext'
export type { TransportContextValue } from './context/TransportContext'

// ── API Client Factory ──
export { createApiClient } from './base-api'
export type { ApiClient, ApiClientConfig } from './base-api'

// ── Components ──
export { default as ChatMessageList } from './components/ChatMessageList'
export type { ChatMessageListRef as ChatMessageListHandle } from './components/ChatMessageList'
export { CliTerminal } from './components/CliTerminal'
export type { CliTerminalHandle } from './components/CliTerminal'
export { default as ConnectionBadge } from './components/ConnectionBadge'
export { default as StatCard } from './components/StatCard'
export { default as ProgressBar } from './components/ProgressBar'
export { default as RemoteView } from './components/RemoteView'
export { default as ScreenshotViewer } from './components/ScreenshotViewer'
export type { ScreenshotViewerProps } from './components/ScreenshotViewer'
export { default as ScreenshotToolbar } from './components/ScreenshotToolbar'
export type { ScreenshotToolbarProps } from './components/ScreenshotToolbar'
export { default as P2PStatusIndicator } from './components/P2PStatusIndicator'
export type { P2PStatusIndicatorProps } from './components/P2PStatusIndicator'

// ── Dashboard Sub-components ──
export { default as ApprovalBanner } from './components/dashboard/ApprovalBanner'
export { default as ChatPane } from './components/dashboard/ChatPane'
export { default as CliTerminalPane } from './components/dashboard/CliTerminalPane'
export { default as ConnectionBanner } from './components/dashboard/ConnectionBanner'
export { default as DashboardHeader } from './components/dashboard/DashboardHeader'
export { default as HistoryModal } from './components/dashboard/HistoryModal'
export { default as DashboardModelModeBar } from './components/dashboard/ModelModeBar'
export { default as SessionTabBar } from './components/dashboard/SessionTabBar'
export { default as ToastContainer } from './components/dashboard/ToastContainer'
export { buildConversations } from './components/dashboard/buildConversations'
export type { ActiveConversation } from './components/dashboard/types'
export { isCliConv, isAcpConv } from './components/dashboard/types'

// ── Utils ──
export {
    formatIdeType, formatUptime, formatBytes, getAgentDisplayName,
    isCliEntry, dedupeAgents, isAgentActive,
    buildProviderMaps, PLATFORM_ICONS, groupByMachine,
} from './utils/daemon-utils'
export type { MachineIdeEntry, MachineCliEntry, MachineAcpEntry } from './utils/daemon-utils'
export { statusPayloadToEntries } from './utils/status-transform'
export type { StatusTransformOptions } from './utils/status-transform'

// ── Managers ──
export { eventManager } from './managers/EventManager'
export type { StatusEventPayload, ToastConfig, SystemMessage, ToastAction, ViewRequestRespondFn } from './managers/EventManager'
// Re-export daemon-core shared types for downstream consumers
export type { ManagedIdeEntry, ManagedCliEntry, ManagedAcpEntry, AcpConfigOption, AcpMode, StatusReportPayload } from './types'
export { cn } from './lib/utils'

// ── UI Components ──
export { PageHeader } from './components/ui/PageHeader'
export { Section } from './components/ui/Section'
export { EmptyState } from './components/ui/EmptyState'
export { AlertBanner } from './components/ui/AlertBanner'
export { FormField, Input, Textarea } from './components/ui/FormField'
export { StatusBadge } from './components/ui/StatusBadge'
export { DataTable } from './components/ui/DataTable'
export { default as ThemeToggle } from './components/ThemeToggle'

// ── Settings (shared) ──
export { ToggleRow } from './components/settings/ToggleRow'
export type { ToggleRowProps } from './components/settings/ToggleRow'
export { BrowserNotificationSettings } from './components/settings/BrowserNotificationSettings'
export { ConnectedMachinesSection } from './components/settings/ConnectedMachinesSection'
export { GeneralThemeSection } from './components/settings/GeneralThemeSection'
export { ChatThemeSection, initChatTheme, getChatTheme, setChatTheme, CHAT_THEMES } from './components/settings/ChatThemeSection'
export type { ChatThemePreset } from './components/settings/ChatThemeSection'
export { AccentColorSection, initAccentColor, getAccentColor, setAccentColor } from './components/settings/AccentColorSection'

// ── Icons ──
export {
    IconDashboard, IconServer, IconUsers, IconUser, IconCreditCard, IconKey,
    IconBook, IconWebhook, IconClipboard, IconSettings, IconInfo,
    IconLogout, IconShield, IconCpu, IconSun, IconMoon, IconSystem,
    IconChat, IconMonitor, IconEye, IconRefresh, IconSearch, IconPlug,
    IconBarChart, IconScroll, IconFolder, IconWarning, IconClock,
    IconTerminal, IconPlay, IconRocket, IconBot, IconThought,
    IconWrench, IconCandle, IconApple, IconLinux, IconWindows, IconBell, IconBuilding,
} from './components/Icons'

// ── Hooks ──
export { useTheme } from './hooks/useTheme'
export type { Theme, ThemePreference } from './hooks/useTheme'
export { useNotificationPrefs, shouldNotify, getNotificationPrefs, setNotificationPrefs } from './hooks/useNotificationPrefs'
export type { NotificationPrefs } from './hooks/useNotificationPrefs'
export { useBrowserNotifications, requestNotificationPermission } from './hooks/useBrowserNotifications'
export { useHiddenTabs } from './hooks/useHiddenTabs'

// ── Compat layer (gradual migration) ──
export { useDaemons, dashboardWS, connectionManager, p2pManager, setupCompat } from './compat'

// ── Pages ──
export { default as Dashboard } from './pages/Dashboard'
export { default as IDEPage } from './pages/IDE'
export { default as MachineDetail } from './pages/MachineDetail'
export { default as MachinesPage } from './pages/Machines'
export { default as NotificationsPage } from './pages/Notifications'
export { default as CapabilitiesPage } from './pages/Capabilities'
export { default as OnboardingModal } from './components/OnboardingModal'

// ── CSS ──
// Import '@adhdev/web-core/src/index.css' in your app entry
