import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * ConnectionBanner — WS connection status banner
 */
export interface ConnectionBannerProps {
    wsStatus: string;
    showReconnected: boolean;
    /** Login page URL — only shown when provided (cloud-only) */
    loginUrl?: string;
    onReconnect?: () => void;
    /**
     * Grace period before showing transient reconnect states.
     * Mobile Safari/PWA resumes can briefly flip WS state while the socket heals;
     * do not surface that as an alarming toast unless it persists.
     */
    reconnectDelayMs?: number;
}

const DEFAULT_RECONNECT_BANNER_DELAY_MS = 5000;

function isReconnectLikeStatus(status: string): boolean {
    return status === 'disconnected' || status === 'reconnecting';
}

export default function ConnectionBanner({
    wsStatus,
    showReconnected,
    loginUrl,
    onReconnect,
    reconnectDelayMs = DEFAULT_RECONNECT_BANNER_DELAY_MS,
}: ConnectionBannerProps) {
    const reconnectLikeStatus = isReconnectLikeStatus(wsStatus);
    const [showReconnectState, setShowReconnectState] = useState(() => !reconnectLikeStatus || reconnectDelayMs <= 0);
    const reconnectBannerWasVisibleRef = useRef(false);

    useEffect(() => {
        if (!reconnectLikeStatus) {
            setShowReconnectState(false);
            return;
        }

        reconnectBannerWasVisibleRef.current = false;

        if (reconnectDelayMs <= 0) {
            reconnectBannerWasVisibleRef.current = true;
            setShowReconnectState(true);
            return;
        }

        setShowReconnectState(false);
        const timer = setTimeout(() => {
            reconnectBannerWasVisibleRef.current = true;
            setShowReconnectState(true);
        }, reconnectDelayMs);

        return () => clearTimeout(timer);
    }, [reconnectDelayMs, reconnectLikeStatus]);

    const showDisconnected = reconnectLikeStatus
        ? showReconnectState
        : wsStatus === 'offline' || wsStatus === 'auth_failed';
    const showConnectedConfirmation = useMemo(() => {
        if (!showReconnected || wsStatus !== 'connected') return false;
        // If the reconnect state resolved inside the grace period, suppress the
        // matching "Connected" toast too; otherwise mobile inbox can flash a
        // success toast for a disconnect the user never saw.
        return reconnectDelayMs <= 0 || reconnectBannerWasVisibleRef.current;
    }, [reconnectDelayMs, showReconnected, wsStatus]);

    const bannerColor = wsStatus === 'auth_failed' ? 'red' : wsStatus === 'offline' ? 'orange' : 'accent';
    const gradients: Record<string, string> = {
        red: 'linear-gradient(90deg, rgba(239,68,68,0.12), rgba(239,68,68,0.04))',
        orange: 'linear-gradient(90deg, rgba(255,107,53,0.12), rgba(255,107,53,0.04))',
        accent: 'linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 18%, transparent), color-mix(in srgb, var(--accent-primary) 6%, transparent))',
    };
    const borders: Record<string, string> = {
        red: '1px solid rgba(239,68,68,0.2)',
        orange: '1px solid rgba(255,107,53,0.2)',
        accent: '1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent)',
    };
    const colors: Record<string, string> = {
        red: '#ef4444',
        orange: '#ff6b35',
        accent: 'var(--accent-primary-light)',
    };

    const overlayClassName = 'fixed left-1/2 top-4 z-[1400] flex items-center justify-center pointer-events-none';
    const overlayStyle = {
        top: 'calc(env(safe-area-inset-top, 0px) + 16px)',
        transform: 'translateX(-50%)',
    } as const;

    return (
        <>
            {showDisconnected && (
                <div className={overlayClassName} style={overlayStyle}>
                    <div
                        className="pointer-events-auto max-w-[min(720px,calc(100vw-24px))] rounded-2xl border px-4 py-3 text-[13px] font-semibold flex items-center gap-2.5 justify-center shadow-[0_18px_40px_rgba(2,6,23,0.24)] backdrop-blur-xl"
                        style={{
                            background: gradients[bannerColor],
                            border: borders[bannerColor],
                            color: colors[bannerColor],
                        }}
                    >
                        <img
                            src="/otter-logo.png" alt=""
                            className="w-5 h-5 shrink-0"
                            style={{
                                opacity: wsStatus === 'auth_failed' ? 0.6 : 1,
                                animation: wsStatus === 'auth_failed' ? undefined : 'pulse 2s ease-in-out infinite',
                                filter: wsStatus === 'auth_failed' ? 'grayscale(1)' : undefined,
                            }}
                        />
                        <span className="min-w-0 text-center whitespace-nowrap">
                            {wsStatus === 'offline' && 'Network offline'}
                            {wsStatus === 'disconnected' && 'Reconnecting'}
                            {wsStatus === 'reconnecting' && 'Reconnecting'}
                            {wsStatus === 'auth_failed' && (
                                loginUrl ? (
                                    <>
                                        Session expired.{' '}
                                        <a href={loginUrl} className="text-inherit underline">Log in again</a>
                                    </>
                                ) : 'Connection failed — refresh the page or try again shortly.'
                            )}
                        </span>
                        {onReconnect && wsStatus !== 'auth_failed' && (
                            <button
                                type="button"
                                className="ml-1 shrink-0 px-2.5 py-1 rounded-md border border-current/30 text-[12px] font-semibold hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
                                onClick={onReconnect}
                                disabled={wsStatus === 'offline'}
                            >
                                Reconnect now
                            </button>
                        )}
                    </div>
                </div>
            )}
            {showConnectedConfirmation && (
                <div className={overlayClassName} style={overlayStyle}>
                    <div className="pointer-events-none rounded-2xl border px-4 py-2 text-xs font-semibold flex items-center gap-2 justify-center bg-gradient-to-r from-green-500/[0.12] to-green-500/[0.04] text-green-400 border-green-500/15 shadow-[0_18px_40px_rgba(2,6,23,0.2)] backdrop-blur-xl animate-[fadeIn_0.3s_ease]">
                        <img src="/otter-logo.png" alt="" className="w-4 h-4" />
                        Connected
                    </div>
                </div>
            )}
        </>
    );
}
