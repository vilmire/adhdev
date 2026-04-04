/**
 * ConnectionBanner — WS connection status banner
 */

export interface ConnectionBannerProps {
    wsStatus: string;
    showReconnected: boolean;
    /** Login page URL — only shown when provided (cloud-only) */
    loginUrl?: string;
}

export default function ConnectionBanner({ wsStatus, showReconnected, loginUrl }: ConnectionBannerProps) {
    const showDisconnected = wsStatus === 'disconnected' || wsStatus === 'reconnecting' || wsStatus === 'offline' || wsStatus === 'auth_failed';

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

    return (
        <>
            {showDisconnected && (
                <div
                    className="py-2.5 px-5 text-[13px] font-semibold flex items-center gap-2.5 justify-center"
                    style={{
                        background: gradients[bannerColor],
                        borderBottom: borders[bannerColor],
                        color: colors[bannerColor],
                    }}
                >
                    <img
                        src="/otter-logo.png" alt=""
                        className="w-5 h-5"
                        style={{
                            opacity: wsStatus === 'auth_failed' ? 0.6 : 1,
                            animation: wsStatus === 'auth_failed' ? undefined : 'pulse 2s ease-in-out infinite',
                            filter: wsStatus === 'auth_failed' ? 'grayscale(1)' : undefined,
                        }}
                    />
                    {wsStatus === 'offline' && 'Network offline — waiting for connection...'}
                    {wsStatus === 'disconnected' && 'Reconnecting to server...'}
                    {wsStatus === 'reconnecting' && 'Reconnecting to server...'}
                    {wsStatus === 'auth_failed' && (
                        loginUrl ? (
                            <>
                                Session expired.{' '}
                                <a href={loginUrl} className="text-inherit underline">Log in again</a>
                            </>
                        ) : 'Connection failed — please restart the server.'
                    )}
                </div>
            )}
            {showReconnected && wsStatus === 'connected' && (
                <div className="py-2 px-4 text-xs font-semibold flex items-center gap-2 justify-center bg-gradient-to-r from-green-500/[0.12] to-green-500/[0.04] text-green-400 border-b border-green-500/15 animate-[fadeIn_0.3s_ease]">
                    <img src="/otter-logo.png" alt="" className="w-4 h-4" />
                    Connected
                </div>
            )}
        </>
    );
}
