import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBrowserNotifications, requestNotificationPermission } from '../hooks/useBrowserNotifications'
import { eventManager } from '../managers/EventManager'
import type { ToastConfig, SystemMessage } from '../managers/EventManager'
import { useDashboardCommands } from '../hooks/useDashboardCommands'

import { useDaemons, dashboardWS, p2pManager } from '../compat'
import { useTransport } from '../context/TransportContext'
import type { DaemonData } from '../types'
import { isCliConv, isAcpConv } from '../components/dashboard/types'
import type { ActiveConversation } from '../components/dashboard/types'
import { useHiddenTabs } from '../hooks/useHiddenTabs'

import { buildConversations } from '../components/dashboard/buildConversations'
import { ptyBus } from '../components/dashboard/ptyBus'

import ConnectionBanner from '../components/dashboard/ConnectionBanner'
import DashboardHeader from '../components/dashboard/DashboardHeader'
import HistoryModal from '../components/dashboard/HistoryModal'
import ToastContainer from '../components/dashboard/ToastContainer'
import PaneGroup from '../components/dashboard/PaneGroup'
import OnboardingModal from '../components/OnboardingModal'
import { IconRefresh } from '../components/Icons'
import { getMachineDisplayName } from '../utils/daemon-utils'

function mapsEqual(a: Map<string, number>, b: Map<string, number>) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
        if (b.get(key) !== value) return false;
    }
    return true;
}

function arraysEqual(a: number[], b: number[]) {
    if (a.length !== b.length) return false;
    return a.every((value, idx) => value === b[idx]);
}

function indexedRecordEqual<T>(a: Record<number, T>, b: Record<number, T>) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => b[key as any] === a[key as any]);
}

function deriveNormalizedGroupLayout(assignments: Map<string, number>, visibleTabKeys: string[]) {
    const validKeys = new Set(visibleTabKeys);
    const usedGroups = visibleTabKeys.length > 0 ? [0] : [];

    for (const [tabKey, groupIndex] of assignments) {
        if (!validKeys.has(tabKey) || groupIndex <= 0 || usedGroups.includes(groupIndex)) continue;
        usedGroups.push(groupIndex);
    }

    usedGroups.sort((a, b) => a - b);

    const mapping: Record<number, number> = {};
    usedGroups.forEach((groupIndex, nextIndex) => {
        mapping[groupIndex] = nextIndex;
    });

    if (usedGroups.length === 0) {
        mapping[0] = 0;
    }

    const normalizedAssignments = new Map<string, number>();
    for (const [tabKey, groupIndex] of assignments) {
        if (!validKeys.has(tabKey) || groupIndex <= 0) continue;
        const nextIndex = mapping[groupIndex];
        if (typeof nextIndex === 'number' && nextIndex > 0) {
            normalizedAssignments.set(tabKey, nextIndex);
        }
    }

    return {
        assignments: normalizedAssignments,
        groupCount: Math.max(1, usedGroups.length),
        mapping,
        usedGroups,
    };
}

function remapIndexedRecord<T>(prev: Record<number, T>, mapping: Record<number, number>) {
    const next: Record<number, T> = {};
    for (const [key, value] of Object.entries(prev)) {
        const mapped = mapping[Number(key)];
        if (typeof mapped === 'number') next[mapped] = value;
    }
    return next;
}

function remapFocusedGroup(current: number, usedGroups: number[], mapping: Record<number, number>) {
    if (usedGroups.length === 0) return 0;
    if (typeof mapping[current] === 'number') return mapping[current];
    const fallbackOldGroup = [...usedGroups].reverse().find(groupIndex => groupIndex < current)
        ?? usedGroups[0];
    return mapping[fallbackOldGroup] ?? 0;
}

function normalizeGroupSizes(prev: number[], usedGroups: number[], fallbackCount: number) {
    if (usedGroups.length <= 1) return [];

    const next = usedGroups.map(groupIndex => prev[groupIndex]).filter((size): size is number => Number.isFinite(size));
    const base = next.length === usedGroups.length
        ? next
        : Array(fallbackCount).fill(100 / fallbackCount);

    const total = base.reduce((sum, size) => sum + size, 0);
    return total > 0
        ? base.map(size => (size / total) * 100)
        : Array(fallbackCount).fill(100 / fallbackCount);
}

export default function Dashboard() {
    const { sendCommand: sendDaemonCommand } = useTransport()
    const [searchParams, setSearchParams] = useSearchParams()
    const urlActiveTab = searchParams.get('activeTab')

    type Toast = { id: number; message: string; type: 'success' | 'info' | 'warning'; timestamp: number; targetKey?: string }
    const daemonCtx = useDaemons() as any
    const { updateIdeChats, screenshotMap, setScreenshotMap } = daemonCtx
    const ides: DaemonData[] = daemonCtx.ides || []
    const [showOnboarding, setShowOnboarding] = useState(() => {
        try { return !localStorage.getItem('adhdev_onboarding_v1') } catch { return false }
    })
    const toasts: Toast[] = daemonCtx.toasts || []
    const setToasts: React.Dispatch<React.SetStateAction<Toast[]>> = daemonCtx.setToasts || (() => {})
    // Abstract connection state (injected by platform)
    const wsStatus = daemonCtx.wsStatus || 'connected'
    const isConnected = daemonCtx.isConnected ?? true
    const connectionStates = daemonCtx.connectionStates || {}
    const retryConnection = daemonCtx.retryConnection; void retryConnection
    const showReconnected = daemonCtx.showReconnected || false
    // ─── Split View state (N-group editor groups) ───────────
    // groupAssignments: Map<tabKey, groupIndex>. Unassigned tabs default to group 0.
    // Persisted to localStorage so split survives page reloads.
    const [groupAssignments, setGroupAssignments] = useState<Map<string, number>>(() => {
        try {
            const saved = localStorage.getItem('adhdev_splitGroups');
            if (saved) {
                const entries: [string, number][] = JSON.parse(saved);
                return new Map(entries);
            }
        } catch { /* noop */ }
        return new Map();
    });
    const [focusedGroup, setFocusedGroup] = useState(() => {
        try {
            const saved = localStorage.getItem('adhdev_focusedGroup');
            if (saved) return parseInt(saved, 10) || 0;
        } catch { /* noop */ }
        return 0;
    });
    // Track each group's actively selected tab
    const [groupActiveTabIds, setGroupActiveTabIds] = useState<Record<number, string | null>>(() => {
        try {
            const saved = localStorage.getItem('adhdev_groupActiveTabs');
            if (saved) return JSON.parse(saved);
        } catch { /* noop */ }
        return {};
    });
    // URL ?activeTab= deep-link: apply once when conversations are available
    const urlTabAppliedRef = useRef(false);
    // Track each group's tab order (for drag reorder persistence)
    const [groupTabOrders, setGroupTabOrders] = useState<Record<number, string[]>>(() => {
        try {
            const saved = localStorage.getItem('adhdev_groupTabOrders');
            if (saved) return JSON.parse(saved);
        } catch { /* noop */ }
        return {};
    });
    // Group flex sizes (percentages). Persisted.
    const [groupSizes, setGroupSizes] = useState<number[]>(() => {
        try {
            const saved = localStorage.getItem('adhdev_splitSizes');
            if (saved) return JSON.parse(saved);
        } catch { /* noop */ }
        return [];
    });

    // Persist group assignments + sizes
    useEffect(() => {
        try {
            if (groupAssignments.size === 0) {
                localStorage.removeItem('adhdev_splitGroups');
            } else {
                localStorage.setItem('adhdev_splitGroups', JSON.stringify([...groupAssignments.entries()]));
            }
        } catch { /* noop */ }
    }, [groupAssignments]);
    useEffect(() => {
        try {
            if (groupSizes.length > 0) localStorage.setItem('adhdev_splitSizes', JSON.stringify(groupSizes));
            else localStorage.removeItem('adhdev_splitSizes');
        } catch { /* noop */ }
    }, [groupSizes]);
    useEffect(() => {
        try { localStorage.setItem('adhdev_focusedGroup', String(focusedGroup)); } catch { /* noop */ }
    }, [focusedGroup]);
    useEffect(() => {
        try { localStorage.setItem('adhdev_groupActiveTabs', JSON.stringify(groupActiveTabIds)); } catch { /* noop */ }
    }, [groupActiveTabIds]);
    useEffect(() => {
        try { localStorage.setItem('adhdev_groupTabOrders', JSON.stringify(groupTabOrders)); } catch { /* noop */ }
    }, [groupTabOrders]);

    // Detect narrow viewport — disable split on mobile
    const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 767px)');
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    const [messageReceivedAt, setMessageReceivedAt] = useState<Record<string, number>>({})
    const [historyModalOpen, setHistoryModalOpen] = useState(false)
    const [actionLogs, setActionLogs] = useState<{ ideId: string; text: string; timestamp: number }[]>([])
    const [localUserMessages, setLocalUserMessages] = useState<Record<string, { role: string; content: string; timestamp: number; _localId: string }[]>>({})
    const [clearedTabs, setClearedTabs] = useState<Record<string, number>>({})

    // Extract detectedIdes from machine-level entry (for standalone)
    const daemonEntry = ides.find(ide => ide.type === 'adhdev-daemon')
    const detectedIdes: { type: string; name: string; running: boolean; id?: string }[] = (daemonEntry as any)?.detectedIdes || []
    const isStandalone = !!daemonEntry



    // Exclude machine-level entry (adhdev-daemon) from chat tabs + deduplicate IDs
    const chatIdes = useMemo(() => {
        const filtered = ides.filter(ide => ide.type !== 'adhdev-daemon');
        // Same-id dedup: keep the entry with richer data (e.g. workspace)
        const seen = new Map<string, DaemonData>();
        for (const ide of filtered) {
            const existing = seen.get(ide.id);
            if (!existing) {
                seen.set(ide.id, ide);
            } else {
                // Prefer the entry with more data (P2P typically has workspace, activeChat etc.)
                const existingRichness = (existing.workspace ? 1 : 0) + ((existing as any).activeChat ? 1 : 0);
                const incomingRichness = (ide.workspace ? 1 : 0) + ((ide as any).activeChat ? 1 : 0);
                if (incomingRichness > existingRichness || (ide.timestamp || 0) > (existing.timestamp || 0)) {
                    seen.set(ide.id, ide);
                }
            }
        }
        return Array.from(seen.values());
    }, [ides]);

    // Derived: All possible "Active Conversations" from all IDEs (memoized)
    const conversations = useMemo(
        () => {
            const convs = buildConversations(chatIdes, localUserMessages, ides, connectionStates);
            const now = Date.now();
            return convs.map(c => {
                const clearedAt = clearedTabs[c.tabKey];
                if (!clearedAt) return c;
                // Force empty messages within 5s after clear
                if (now - clearedAt < 5000) {
                    return { ...c, messages: [], title: '' };
                }
                // After 5s: wait until server sends new messages, release clear
                return c;
            });
        },
        [chatIdes, localUserMessages, clearedTabs, ides]
    );

    const resolveConversationByTarget = useCallback((target: string | null | undefined) => {
        if (!target) return undefined;
        return conversations.find(c =>
            c.sessionId === target
            || c.ideId === target
            || c.tabKey === target
            || c.ideType === target
            || c.agentType === target
        );
    }, [conversations]);

    // ─── Hidden Tabs ───
    const { hiddenTabs, toggleTab: toggleHiddenTab } = useHiddenTabs();
    const visibleConversations = useMemo(
        () => conversations.filter(c => !hiddenTabs.has(c.tabKey)),
        [conversations, hiddenTabs],
    );

    const visibleTabKeys = useMemo(
        () => visibleConversations.map(conv => conv.tabKey),
        [visibleConversations],
    );

    const normalizedGroupLayout = useMemo(
        () => deriveNormalizedGroupLayout(groupAssignments, visibleTabKeys),
        [groupAssignments, visibleTabKeys],
    );
    const normalizedGroupAssignments = normalizedGroupLayout.assignments;

    const numGroups = useMemo(() => {
        if (isMobile) return 1;
        return normalizedGroupLayout.groupCount;
    }, [normalizedGroupLayout.groupCount, isMobile]);
    const isSplitMode = numGroups > 1;

    const shiftIndexedRecordRight = useCallback(<T,>(prev: Record<number, T>, insertIndex: number) => {
        const next: Record<number, T> = {};
        for (const [key, value] of Object.entries(prev)) {
            const idx = Number(key);
            next[idx >= insertIndex ? idx + 1 : idx] = value;
        }
        return next;
    }, []);

    const buildDefaultSizes = useCallback((count: number) => Array(count).fill(100 / count), []);

    const moveTabToGroup = useCallback((tabKey: string, targetGroup: number) => {
        setGroupAssignments(prev => {
            const next = new Map(deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments);
            if (targetGroup === 0) next.delete(tabKey);
            else next.set(tabKey, targetGroup);
            return next;
        });
        setGroupActiveTabIds(prev => ({ ...prev, [targetGroup]: tabKey }));
        setFocusedGroup(targetGroup);
    }, [visibleTabKeys]);

    const closeGroup = useCallback((groupIdx: number) => {
        setGroupAssignments(prev => {
            const current = deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments;
            const next = new Map<string, number>();
            for (const [key, g] of current) {
                if (g === groupIdx) continue;
                if (g > groupIdx) next.set(key, g - 1);
                else next.set(key, g);
            }
            return next;
        });
        setGroupSizes(prev => {
            if (prev.length <= 1) return [];
            const next = [...prev];
            next.splice(groupIdx, 1);
            const total = next.reduce((sum, size) => sum + size, 0);
            return total > 0 ? next.map(size => (size / total) * 100) : [];
        });
        setFocusedGroup(0);
    }, [visibleTabKeys]);

    const containerRef = useRef<HTMLDivElement>(null);
    const handleResizeStart = useCallback((dividerIdx: number, e: React.MouseEvent) => {
        e.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        const startX = e.clientX;
        const totalWidth = container.offsetWidth;
        const startSizes = groupSizes.length === numGroups
            ? [...groupSizes]
            : Array(numGroups).fill(100 / numGroups);

        const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startX;
            const pctDelta = (dx / totalWidth) * 100;
            const next = [...startSizes];
            next[dividerIdx] = Math.max(15, startSizes[dividerIdx] + pctDelta);
            next[dividerIdx + 1] = Math.max(15, startSizes[dividerIdx + 1] - pctDelta);
            setGroupSizes(next);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [groupSizes, numGroups]);

    const splitTabRelative = useCallback((tabKey: string, targetGroup: number, side: 'left' | 'right') => {
        const currentGroupCount = numGroups;
        if (currentGroupCount >= 4) return;

        const insertIndex = side === 'left' ? targetGroup : targetGroup + 1;

        setGroupAssignments(prev => {
            const current = deriveNormalizedGroupLayout(prev, visibleTabKeys).assignments;
            const next = new Map<string, number>();
            for (const conv of visibleConversations) {
                const currentGroup = current.get(conv.tabKey) ?? 0;
                const shiftedGroup = currentGroup >= insertIndex ? currentGroup + 1 : currentGroup;
                if (shiftedGroup > 0) next.set(conv.tabKey, shiftedGroup);
            }
            if (insertIndex > 0) next.set(tabKey, insertIndex);
            return next;
        });

        setGroupSizes(prev => {
            const base = prev.length === currentGroupCount ? [...prev] : buildDefaultSizes(currentGroupCount);
            const targetSize = base[targetGroup] ?? (100 / currentGroupCount);
            const kept = Math.max(15, targetSize / 2);
            const inserted = Math.max(15, targetSize / 2);
            const next = [...base];
            next[targetGroup] = kept;
            next.splice(insertIndex, 0, inserted);
            const total = next.reduce((sum, size) => sum + size, 0);
            return next.map(size => (size / total) * 100);
        });

        setGroupActiveTabIds(prev => {
            const next = shiftIndexedRecordRight(prev, insertIndex);
            next[insertIndex] = tabKey;
            return next;
        });

        setGroupTabOrders(prev => {
            const next = shiftIndexedRecordRight(prev, insertIndex);
            next[insertIndex] = [tabKey];
            return next;
        });

        setFocusedGroup(insertIndex);
    }, [numGroups, visibleConversations, visibleTabKeys, buildDefaultSizes, shiftIndexedRecordRight]);

    // ─── Browser Notifications ───
    // Request permission on mount
    useEffect(() => { requestNotificationPermission() }, [])
    // Extract agent states for notification hook
    const agentStates = useMemo(() =>
        visibleConversations.map(c => ({
            id: c.tabKey,
            name: c.title || c.agentName || c.ideId,
            status: c.status,
            activeModal: c.modalMessage ? { message: c.modalMessage, buttons: c.modalButtons } : null,
        })),
        [visibleConversations],
    )
    useBrowserNotifications(agentStates)

    // Keep split-group state compact: no explicit group 0 entries and no empty gaps.
    useEffect(() => {
        if (mapsEqual(groupAssignments, normalizedGroupAssignments)) return;
        setGroupAssignments(normalizedGroupAssignments);
    }, [groupAssignments, normalizedGroupAssignments]);

    useEffect(() => {
        const { mapping, usedGroups } = normalizedGroupLayout;

        setGroupActiveTabIds(prev => {
            const next = remapIndexedRecord(prev, mapping);
            return indexedRecordEqual(prev, next) ? prev : next;
        });

        setGroupTabOrders(prev => {
            const next = remapIndexedRecord(prev, mapping);
            return indexedRecordEqual(prev, next) ? prev : next;
        });

        setFocusedGroup(prev => {
            const next = isMobile ? 0 : remapFocusedGroup(prev, usedGroups, mapping);
            return prev === next ? prev : next;
        });

        setGroupSizes(prev => {
            const next = isMobile ? [] : normalizeGroupSizes(prev, usedGroups, normalizedGroupLayout.groupCount);
            return arraysEqual(prev, next) ? prev : next;
        });
    }, [normalizedGroupLayout, isMobile]);

    // Split conversations into N groups
    const groupedConvs = useMemo(() => {
        const groups: ActiveConversation[][] = Array.from({ length: numGroups }, () => []);
        for (const conv of visibleConversations) {
            const g = normalizedGroupAssignments.get(conv.tabKey) ?? 0;
            const idx = Math.min(g, numGroups - 1);
            groups[idx].push(conv);
        }
        return groups;
    }, [visibleConversations, normalizedGroupAssignments, numGroups]);

    // ─── URL ?activeTab= deep-link resolution ───
    // Matches the URL's activeTab (raw ideId like "cursor" or instance UUID) to a conversation tabKey.
    // Applied once when conversations become available, then clears the URL param.
    useEffect(() => {
        if (!urlActiveTab || urlTabAppliedRef.current || conversations.length === 0) return;
        const match = resolveConversationByTarget(urlActiveTab);
        if (match) {
            const targetGroup = normalizedGroupAssignments.get(match.tabKey) ?? 0;
            setGroupActiveTabIds(prev => ({ ...prev, [targetGroup]: match.tabKey }));
            setFocusedGroup(targetGroup);
            urlTabAppliedRef.current = true;
            // Clean URL (remove ?activeTab= to avoid stale state)
            setSearchParams(prev => {
                const next = new URLSearchParams(prev);
                next.delete('activeTab');
                return next;
            }, { replace: true });
        }
    }, [urlActiveTab, conversations, normalizedGroupAssignments, resolveConversationByTarget]);

    // clearedTabs auto-cleanup (after 5s)
    useEffect(() => {
        const keys = Object.keys(clearedTabs);
        if (keys.length === 0) return;
        const timer = setTimeout(() => {
            setClearedTabs(prev => {
                const now = Date.now();
                const next: Record<string, number> = {};
                for (const [k, v] of Object.entries(prev)) {
                    if (now - v < 5000) next[k] = v;
                }
                return Object.keys(next).length === Object.keys(prev).length ? prev : next;
            });
        }, 5500);
        return () => clearTimeout(timer);
    }, [clearedTabs]);

    // activeConv for header/history — use focused group's actual selected tab
    const activeConv = useMemo(() => {
        const focusedTabKey = groupActiveTabIds[focusedGroup];
        if (focusedTabKey) {
            const found = conversations.find(c => c.tabKey === focusedTabKey);
            if (found) return found;
        }
        // Fallback: first conv in focused group, then first conv overall
        return groupedConvs[focusedGroup]?.[0] || groupedConvs[0]?.[0];
    }, [groupActiveTabIds, focusedGroup, conversations, groupedConvs]);

    // Helper: pin (no-op in group-based model, PaneGroup handles its own activeTab)
    const pinTab = useCallback((_tabKey: string, _delays: number[]) => {}, []);



    // message Record first receive time (client-only, not saved/sent)
    useEffect(() => {
        const now = Date.now()
        let updated = false
        const next = { ...messageReceivedAt }
        for (const conv of conversations) {
            if (!conv.messages?.length) continue
            conv.messages.forEach((m: any, i: number) => {
                const key = `${conv.ideId}-${m.id ?? `i-${i}`}`
                if (next[key] == null) { next[key] = now; updated = true }
            })
        }
        if (updated) setMessageReceivedAt(next)
    }, [conversations])

    // Only open history modal, use status(ide.chats) for list. Call list_chats only once when empty.
    const historyRefreshedRef = useRef(false);
    useEffect(() => {
        if (!historyModalOpen) { historyRefreshedRef.current = false; return; }
        if (!activeConv || historyRefreshedRef.current || isRefreshingHistory) return;
        const ide = ides.find((i: DaemonData) => i.id === activeConv.ideId);
        if (ide && (!ide.chats || ide.chats.length === 0)) {
            historyRefreshedRef.current = true;
            handleRefreshHistory();
        }
    }, [historyModalOpen, activeConv?.ideId]);

    // actionLogs auto-cleanup — 5min TTL + 100 items cap
    useEffect(() => {
        const timer = setInterval(() => {
            const cutoff = Date.now() - 300_000;
            setActionLogs(prev => {
                const filtered = prev.filter(l => l.timestamp > cutoff).slice(-100);
                return filtered.length === prev.length ? prev : filtered;
            });
        }, 60_000);
        return () => clearInterval(timer);
    }, []);

    // Per-CLI-tab PTY buffer — preserve inactive tab data
    const ptyBuffers = useRef<Map<string, string[]>>(new Map());

    // PTY output → save to buffer (terminal write handled by PaneGroup's CliTerminalPane)
    useEffect(() => {
        const writePty = (cliId: string, data: string) => {
            if (!data) return
            // Broadcast to ptyBus so active CliTerminalPane can write to xterm in real-time
            ptyBus.emit(cliId, data)
            for (const conv of conversations) {
                if (!isCliConv(conv)) continue;
                const convCliMatch = cliId === conv.sessionId || cliId === conv.ideId || cliId === conv.tabKey;
                if (convCliMatch) {
                    const buf = ptyBuffers.current.get(conv.tabKey) || [];
                    buf.push(data);
                    if (buf.length > 10000) buf.splice(0, buf.length - 5000);
                    ptyBuffers.current.set(conv.tabKey, buf);
                }
            }
        }
        const unsubP2P = p2pManager.onPtyOutput(writePty)
        return () => { unsubP2P() }
    }, [conversations])

    // Keyboard: Ctrl+\ toggle split, Ctrl+[/] switch group focus
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === '\\') {
                e.preventDefault();
                if (isSplitMode) {
                    // Close all splits
                    setGroupAssignments(new Map());
                    setFocusedGroup(0);
                } else {
                    const second = conversations[1];
                    if (second) splitTabRelative(second.tabKey, 0, 'right');
                }
                return;
            }
            if (e.ctrlKey && (e.key === '[' || e.key === ']') && isSplitMode) {
                e.preventDefault();
                setFocusedGroup(prev => {
                    if (e.key === ']') return Math.min(prev + 1, numGroups - 1);
                    return Math.max(prev - 1, 0);
                });
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isSplitMode, conversations, splitTabRelative, numGroups]);

    // ─── Centralized Event Manager wiring ──────────────────────────────
    // Provide current IDEs and resolve action fn to EventManager
    useEffect(() => {
        eventManager.setIdes(ides)
    }, [ides])

    useEffect(() => {
        eventManager.setResolveAction((routeId, cmd, payload) => {
            sendDaemonCommand(routeId, cmd, payload).catch(() => {})
        })
    }, [sendDaemonCommand])

    // Subscribe to EventManager outputs → wire into React state
    useEffect(() => {
        const unsubToast = eventManager.onToast((toast: ToastConfig) => {
            setToasts(prev => {
                // Dedup: skip if identical message exists within last 3s
                const isDup = prev.some(t => t.message === toast.message && (toast.timestamp - t.timestamp) < 3000)
                if (isDup) return prev
                return [...prev.slice(-4), {
                    id: toast.id, message: toast.message, type: toast.type,
                    timestamp: toast.timestamp, targetKey: toast.targetKey,
                    actions: toast.actions as any,
                }]
            })
            const dur = toast.duration || 5000
            setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), dur)
        })

        const unsubSysMsg = eventManager.onSystemMessage((targetKey: string, msg: SystemMessage) => {
            setLocalUserMessages(prev => ({
                ...prev,
                [targetKey]: [...(prev[targetKey] || []), msg],
            }))
        })

        const unsubClearSysMsg = eventManager.onClearSystemMessage((targetKey: string, prefix: string) => {
            setLocalUserMessages(prev => {
                if (!prev[targetKey]?.length) return prev
                return {
                    ...prev,
                    [targetKey]: prev[targetKey].filter(
                        (m: any) => !(m.role === 'system' && m._localId?.startsWith(prefix))
                    ),
                }
            })
        })

        return () => { unsubToast(); unsubSysMsg(); unsubClearSysMsg() }
    }, [])

    // Subscribe to status_event from WS only → feed into EventManager
    useEffect(() => {
        const unsubWS = dashboardWS.on('status_event', (payload: any) => eventManager.handleRawEvent(payload, 'ws'))
        return () => { unsubWS() }
    }, [])

    // SW notification action handler (on push notification button click)
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data
            if (data?.type === 'notification_action' && data.action === 'approve' && (data.ideId || data.targetSessionId || data.targetKey)) {
                const targetKey = data.targetSessionId || data.targetKey || data.ideId
                const matchedConv = resolveConversationByTarget(targetKey)
                const routeId = matchedConv?.ideId || data.ideId
                if (!routeId) return
                sendDaemonCommand(routeId, 'resolve_action', {
                    action: 'approve',
                    button: 'Approve',
                    ...(matchedConv?.sessionId && { targetSessionId: matchedConv.sessionId }),
                    ...(data.targetSessionId && { targetSessionId: data.targetSessionId }),
                }).catch(e => console.error('[SW Action] approve failed:', e))
            }
        }
        navigator.serviceWorker?.addEventListener('message', handler)
        return () => navigator.serviceWorker?.removeEventListener('message', handler)
    }, [resolveConversationByTarget, sendDaemonCommand])

    // ─── Command Handlers (header/history use activeConv) ──────
    const {
        agentInput: _agentInput, setAgentInput: _setAgentInput,
        isCreatingChat, isRefreshingHistory, isFocusingAgent: _isFocusingAgent,
        handleSendChat: _handleSendChat, handleRelaunch: _handleRelaunch, handleLaunchIde,
        handleModalButton: _handleModalButton, handleSwitchSession,
        handleNewChat, handleFocusAgent: _handleFocusAgent, handleRefreshHistory,
    } = useDashboardCommands({
        sendDaemonCommand,
        activeConv,
        ides,
        updateIdeChats,
        setToasts,
        setLocalUserMessages,
        setClearedTabs,
        setActionLogs,
        pinTab,
        isStandalone,
    });

    const handleActiveCliStop = useCallback(async () => {
        if (!activeConv || !isCliConv(activeConv) || isAcpConv(activeConv)) return;
        const cliType = activeConv.ideType || activeConv.agentType || '';
        if (!window.confirm(`Stop ${cliType}?\nThis will terminate the CLI process.`)) return;
        const daemonId = activeConv.ideId || activeConv.daemonId || '';
        try {
            await sendDaemonCommand(daemonId, 'stop_cli', { cliType, targetSessionId: activeConv.sessionId });
        } catch (e: any) {
            console.error('Stop CLI failed:', e);
        }
    }, [activeConv, sendDaemonCommand]);

    // Version mismatch detection — collect ALL outdated daemons
    const versionMismatchDaemons = useMemo(() =>
        ides.filter((d: any) => d.type === 'adhdev-daemon' && d.versionMismatch),
    [ides])
    const [versionBannerDismissed, setVersionBannerDismissed] = useState(false)
    const [upgradingDaemons, setUpgradingDaemons] = useState<Record<string, 'upgrading' | 'done' | 'error'>>({})

    const handleBannerUpgrade = useCallback(async (daemonId: string) => {
        setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'upgrading' }))
        try {
            const result = await sendDaemonCommand(daemonId, 'daemon_upgrade', {})
            if (result?.result?.upgraded || result?.result?.success) {
                setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'done' }))
            } else {
                setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'error' }))
            }
        } catch {
            setUpgradingDaemons(prev => ({ ...prev, [daemonId]: 'error' }))
        }
    }, [sendDaemonCommand])

    return (
        <div className="page-dashboard flex-1 min-h-0 bg-bg-primary text-text-primary flex flex-col overflow-hidden">

            <ConnectionBanner wsStatus={wsStatus} showReconnected={showReconnected} />

            {/* Version mismatch banner — shows all outdated machines */}
            {versionMismatchDaemons.length > 0 && !versionBannerDismissed && (
                <div className="flex items-center gap-2.5 px-4 py-2 bg-amber-500/[0.08] border-b border-amber-500/20 text-xs text-text-secondary shrink-0 flex-wrap">
                    <span className="text-sm shrink-0 mt-0.5"><IconRefresh size={14} className="text-amber-500" /></span>
                    <span className="flex-1 flex items-center gap-2 flex-wrap min-w-0">
                        <span>
                            Update available: <strong>v{(versionMismatchDaemons[0] as any).version}</strong> → <strong>v{(versionMismatchDaemons[0] as any).serverVersion}</strong>
                        </span>
                        {versionMismatchDaemons.map((d: any) => {
                            const name = getMachineDisplayName(d, { fallbackId: d.id })
                            const state = upgradingDaemons[d.id]
                            return (
                                <span key={d.id} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-500/[0.08] border border-amber-500/15">
                                    <span className="font-medium text-text-primary">{name}</span>
                                    <span className="text-[10px] text-text-muted">v{d.version}</span>
                                    {state === 'upgrading' ? (
                                        <span className="text-[10px] text-amber-400 animate-pulse">upgrading…</span>
                                    ) : state === 'done' ? (
                                        <span className="text-[10px] text-green-400">✓ restarting</span>
                                    ) : state === 'error' ? (
                                        <button
                                            className="text-[10px] text-red-400 hover:text-red-300 underline cursor-pointer"
                                            onClick={() => handleBannerUpgrade(d.id)}
                                        >retry</button>
                                    ) : (
                                        <button
                                            className="text-[10px] font-semibold text-amber-400 hover:text-amber-300 cursor-pointer px-1.5 py-px rounded bg-amber-500/10 border border-amber-500/20 transition-colors"
                                            onClick={() => handleBannerUpgrade(d.id)}
                                        >Upgrade</button>
                                    )}
                                </span>
                            )
                        })}
                    </span>
                    <button
                        className="text-text-muted hover:text-text-primary transition-colors text-sm px-1 shrink-0"
                        onClick={() => setVersionBannerDismissed(true)}
                        title="Dismiss"
                    >✕</button>
                </div>
            )}



            {/* 1. Header Area */}
            <DashboardHeader
                activeConv={activeConv}
                agentCount={chatIdes.length}
                wsStatus={wsStatus}
                isConnected={isConnected}
                onOpenHistory={() => setHistoryModalOpen(true)}
                onStopCli={handleActiveCliStop}
            />

            {/* 2. Editor Groups (each with own tab bar + content) */}
            <div ref={containerRef} className={`flex-1 min-h-0 flex ${isSplitMode ? 'flex-row' : 'flex-col'} overflow-hidden`}>
                {groupedConvs.map((convs, gIdx) => {
                    const flexBasis = isSplitMode && groupSizes.length === numGroups
                        ? `${groupSizes[gIdx]}%`
                        : undefined;
                    return (
                        <React.Fragment key={gIdx}>
                            {/* Resize divider (between groups, not before first) */}
                            {isSplitMode && gIdx > 0 && (
                                <div
                                    className="shrink-0 w-1 cursor-col-resize hover:bg-accent/30 transition-colors relative group"
                                    style={{ background: 'var(--border-subtle)' }}
                                    onMouseDown={(e) => handleResizeStart(gIdx - 1, e)}
                                    onDoubleClick={() => closeGroup(gIdx)}
                                    title="Drag to resize · Double-click to merge"
                                >
                                    <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/10" />
                                </div>
                            )}
                            <PaneGroup
                                style={isSplitMode ? {
                                    flexBasis: flexBasis ?? `${100 / numGroups}%`,
                                    flexGrow: flexBasis ? 0 : 1,
                                    flexShrink: flexBasis ? 0 : 1,
                                } : undefined}
                                conversations={convs}
                                ides={ides}
                                messageReceivedAt={messageReceivedAt}
                                actionLogs={actionLogs}
                                ptyBuffers={ptyBuffers}
                                screenshotMap={screenshotMap}
                                setScreenshotMap={setScreenshotMap}
                                sendDaemonCommand={sendDaemonCommand}
                                updateIdeChats={updateIdeChats}
                                setToasts={setToasts}
                                setLocalUserMessages={setLocalUserMessages}
                                setClearedTabs={setClearedTabs}
                                setActionLogs={setActionLogs}
                                pinTab={pinTab}
                                isStandalone={isStandalone}
                                userName={daemonCtx.userName}
                                groupIndex={gIdx}
                                isFocused={focusedGroup === gIdx}
                                onFocus={() => setFocusedGroup(gIdx)}
                                isSplitMode={isSplitMode}
                                numGroups={numGroups}
                                onMoveTab={(tabKey, direction) => {
                                    if (direction === 'left' && gIdx > 0) moveTabToGroup(tabKey, gIdx - 1);
                                    else if (direction === 'right' && gIdx < numGroups - 1) moveTabToGroup(tabKey, gIdx + 1);
                                    else if (direction === 'split-left' && numGroups < 4) splitTabRelative(tabKey, gIdx, 'left');
                                    else if (direction === 'split-right' && numGroups < 4) splitTabRelative(tabKey, gIdx, 'right');
                                }}
                                onClose={isSplitMode ? () => closeGroup(gIdx) : undefined}
                                onReceiveTab={(tabKey) => moveTabToGroup(tabKey, gIdx)}
                                detectedIdes={gIdx === 0 ? detectedIdes : undefined}
                                handleLaunchIde={gIdx === 0 ? handleLaunchIde : undefined}
                                onActiveTabChange={(tabKey) => setGroupActiveTabIds(prev => ({ ...prev, [gIdx]: tabKey }))}
                                initialActiveTabId={groupActiveTabIds[gIdx]}
                                initialTabOrder={groupTabOrders[gIdx]}
                                onTabOrderChange={(order) => setGroupTabOrders(prev => ({ ...prev, [gIdx]: order }))}
                                onHideTab={toggleHiddenTab}
                            />
                        </React.Fragment>
                    );
                })}

            </div>

            {/* History Modal */}
            {historyModalOpen && activeConv && (
                <HistoryModal
                    activeConv={activeConv}
                    ides={ides}
                    isCreatingChat={isCreatingChat}
                    isRefreshingHistory={isRefreshingHistory}
                    onClose={() => setHistoryModalOpen(false)}
                    onNewChat={handleNewChat}
                    onSwitchSession={handleSwitchSession}
                    onRefreshHistory={handleRefreshHistory}
                />
            )}

            <style>{`
                body { overflow: hidden; overscroll-behavior: none; }
                .pulse-amber { animation: pulse-amber 2s infinite ease-in-out; }
    @keyframes pulse-amber {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7); }
        70% { transform: scale(1.1); box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
                }
`}</style>

            {/* Toast Notifications */}
            <ToastContainer
                toasts={toasts}
                onDismiss={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
                onClickToast={(toast) => {
                    if (toast.targetKey) {
                        const matchedConv = resolveConversationByTarget(toast.targetKey);
                        if (matchedConv) {
                            setFocusedGroup(normalizedGroupAssignments.get(matchedConv.tabKey) ?? 0);
                        }
                    }
                }}
            />
            <style>{`
@keyframes toast -in {
    from { opacity: 0; transform: translateX(40px); }
                    to { opacity: 1; transform: translateX(0); }
                }
`}</style>
            {showOnboarding && (
                <OnboardingModal onClose={() => {
                    try { localStorage.setItem('adhdev_onboarding_v1', 'done') } catch {}
                    setShowOnboarding(false)
                }} />
            )}
        </div>
    )
}
