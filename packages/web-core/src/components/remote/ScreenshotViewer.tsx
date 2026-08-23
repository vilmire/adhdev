import { useRef, useCallback } from 'react';
import { IconX } from '../Icons';

export interface ScreenshotViewerProps {
  screenshotUrl: string | null;
  mode?: 'preview' | 'full';
  zoom?: number;
  interactive?: boolean;
  connectionState?: string;
  onDismiss?: () => void;
  onClickAt?: (x: number, y: number, naturalWidth: number, naturalHeight: number) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  badge?: string;
  emptyMessage?: string;
  aspectRatio?: string;
  className?: string;
  style?: React.CSSProperties;
}

export default function ScreenshotViewer({
  screenshotUrl,
  mode = 'preview',
  zoom = 100,
  interactive = false,
  connectionState,
  onDismiss,
  onClickAt,
  onKeyDown,
  badge,
  emptyMessage,
  aspectRatio,
  className,
  style,
}: ScreenshotViewerProps) {
  const imgRef = useRef<HTMLImageElement>(null);

  const handleClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!interactive || !onClickAt || !imgRef.current) return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * img.naturalWidth;
    const y = (e.clientY - rect.top) / rect.height * img.naturalHeight;
    onClickAt(x, y, img.naturalWidth, img.naturalHeight);
  }, [interactive, onClickAt]);

  if (mode === 'preview') {
    if (!screenshotUrl) return null;

    return (
      <div
        className={`relative rounded-xl overflow-hidden border border-border-subtle bg-bg-secondary ${className || ''}`}
        style={{ aspectRatio: aspectRatio || '16/9', ...style }}
      >
        <img
          ref={imgRef}
          src={screenshotUrl}
          alt="IDE Screenshot"
          className="w-full h-full object-cover"
        />
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="absolute top-2.5 right-2.5 bg-black/50 border-none text-white w-5 h-5 rounded-full text-3xs z-10 cursor-pointer flex items-center justify-center"
          >
            <IconX size={12} />
          </button>
        )}
      </div>
    );
  }

  if (!screenshotUrl) {
    return (
      <div
        className={`flex items-center justify-center flex-col gap-2 h-full text-text-muted ${className || ''}`}
        style={style}
      >
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center border border-white/10 bg-white/[0.04] shadow-[0_10px_30px_rgba(0,0,0,0.22)] mb-1"
          style={{ animation: 'remote-float 2.8s ease-in-out infinite' }}
        >
          <img src="/otter-logo.png" alt="" className="w-8 h-8 opacity-90" />
        </div>
        <p className="text-base">{emptyMessage || 'Waiting for screenshot stream...'}</p>
        {connectionState && (
          <p className="text-[13px] mt-2 opacity-50">P2P: {connectionState}</p>
        )}
        <style>{`
          @keyframes remote-float {
            0% { transform: translateY(0px); }
            50% { transform: translateY(-7px); }
            100% { transform: translateY(0px); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div
      className={`${interactive ? 'screenshot-interactive' : ''} ${className || ''} relative h-full flex items-center justify-center overflow-auto`}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      style={style}
    >
      <img
        ref={imgRef}
        src={screenshotUrl}
        alt="IDE Screenshot"
        onClick={interactive ? handleClick : undefined}
        className="max-w-full max-h-full object-contain"
        style={{
          ...(interactive ? { cursor: 'crosshair' } : {}),
          ...(zoom !== 100 ? { transform: `scale(${zoom / 100})`, transformOrigin: 'center center' } : {}),
        }}
      />
      {badge && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-3.5 py-1.5 rounded-[20px] text-xs font-semibold backdrop-blur-sm">
          {badge}
        </div>
      )}
    </div>
  );
}
