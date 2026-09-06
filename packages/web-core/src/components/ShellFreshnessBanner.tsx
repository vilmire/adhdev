import { useState } from 'react';
import { useShellFreshness, type UseShellFreshnessOptions } from '../hooks/useShellFreshness';

/**
 * (SHELL-FRESHNESS) "A new version is available" prompt.
 *
 * ★ Never reloads on its own. The staleness is typically hours old by the time
 * it is noticed, so it is never urgent enough to justify discarding the user's
 * in-flight work (an unsent message, a scrolled transcript, an open modal).
 * The reload is always a click, and the banner is dismissible — a user who
 * wants to finish what they are doing must be able to make it go away without
 * losing that work.
 */
export interface ShellFreshnessBannerProps extends UseShellFreshnessOptions {
    className?: string;
}

export default function ShellFreshnessBanner({ className, ...options }: ShellFreshnessBannerProps) {
    const { isStale, reload } = useShellFreshness(options);
    const [dismissed, setDismissed] = useState(false);

    if (!isStale || dismissed) return null;

    return (
        <div
            className={
                className
                || 'fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+16px)] z-[var(--z-toast)] flex items-center justify-center pointer-events-none'
            }
            style={{ transform: 'translateX(-50%)' }}
        >
            <div
                className="pointer-events-auto max-w-[min(720px,calc(100vw-24px))] rounded-2xl border px-3 py-2.5 sm:px-4 sm:py-3 text-[13px] leading-[1.6] font-semibold flex flex-wrap items-center gap-x-2.5 gap-y-2 justify-center shadow-[0_18px_40px_rgba(2,6,23,0.24)] backdrop-blur-xl"
                style={{
                    background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 18%, transparent), color-mix(in srgb, var(--accent-primary) 6%, transparent))',
                    border: '1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent)',
                    color: 'var(--accent-primary-light)',
                }}
                role="status"
            >
                <span className="min-w-0 text-center">A new version of ADHDev is available.</span>
                <button
                    type="button"
                    className="shrink-0 px-2.5 py-1 rounded-md border border-current/30 text-[12px] leading-[1.6] font-semibold hover:bg-white/5"
                    onClick={reload}
                >
                    Reload
                </button>
                <button
                    type="button"
                    className="shrink-0 px-2 py-1 rounded-md text-[12px] leading-[1.6] font-semibold opacity-70 hover:opacity-100"
                    onClick={() => setDismissed(true)}
                    aria-label="Dismiss update notice"
                >
                    Later
                </button>
            </div>
        </div>
    );
}
