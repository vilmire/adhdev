import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconX } from './Icons'
import ModalPortal from './ui/ModalPortal'
import { IconCheckCircle, IconEye, IconGitBranch, IconGlobe, IconInfo, IconChat, IconMousePointer, IconRocket, IconSmartphone } from './Icons'

interface OnboardingModalProps {
  onClose: () => void
  /** Standalone dashboard: the daemon is already running and connected, so the
   *  closing step must not tell the user to install it. */
  standalone?: boolean
}

/** `key` selects the copy under `app.onboardingTour.<key>.{title,desc}` (common ns). */
interface OnboardingStep {
  icon: typeof IconInfo
  key: string
  visual?: typeof IconInfo
  code?: string
}

const SHARED_STEPS: OnboardingStep[] = [
  { icon: IconRocket, key: 'welcome', visual: IconGlobe },
  { icon: IconChat, key: 'realtimeChat', visual: IconSmartphone },
  { icon: IconEye, key: 'watchAndSteer', visual: IconMousePointer },
  { icon: IconGitBranch, key: 'orchestrate', visual: IconGitBranch },
]

const CLOUD_FINAL_STEP: OnboardingStep = {
  icon: IconRocket,
  key: 'getStartedCloud',
  code: 'curl -fsSL https://adhf.dev/install | sh',
}

const STANDALONE_FINAL_STEP: OnboardingStep = {
  icon: IconRocket,
  key: 'allSetStandalone',
  visual: IconCheckCircle,
}

export default function OnboardingModal({ onClose, standalone = false }: OnboardingModalProps) {
  const [step, setStep] = useState(0)
  const { t } = useTranslation('common')
  const steps = [...SHARED_STEPS, standalone ? STANDALONE_FINAL_STEP : CLOUD_FINAL_STEP]
  const current = steps[step]
  const isLast = step === steps.length - 1

  // Escape closes the modal — required alternate dismissal path on desktop and
  // hardware-keyboard mobile sessions.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <ModalPortal>
    <div
      className="onboarding-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 'var(--z-modal)',
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Keep the surface clear of the iOS PWA status bar / home indicator
        // (viewport-fit=cover extends the fixed overlay under the system UI).
        padding: 'calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px))',
        animation: 'fadeIn 0.3s ease-out',
      }}
      onClick={(e) => { e.stopPropagation() }}
    >
      <div
        style={{
          background: 'var(--bg-secondary, #1a1a2e)',
          border: '1px solid var(--border-subtle, #333)',
          borderRadius: '1.25rem',
          width: 'min(440px, 92vw)',
          // Cap the height inside the safe area and scroll long content instead
          // of pushing the close control / actions off-screen on small phones.
          maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 32px)',
          overflowY: 'auto',
          padding: '2.5rem 2rem 2rem',
          position: 'relative',
          animation: 'slideUp 0.3s ease-out',
        }}
      >
        {/* Close — >=44px tap target (Apple HIG); the -6px margin keeps the
            visual position identical to the old 20px icon-only button. */}
        <button
          onClick={onClose}
          aria-label={t('app.onboardingTour.closeAria')}
          className="absolute top-3 right-4 bg-transparent border-none text-text-muted hover:text-text-primary transition-colors cursor-pointer"
          style={{ minWidth: 44, minHeight: 44, margin: -6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        ><IconX size={20} /></button>

        {/* Step indicator */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: '1.5rem' }}>
          {steps.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === step ? 24 : 8, height: 8,
                borderRadius: 4,
                background: i === step
                  ? 'var(--accent, #7c3aed)'
                  : 'var(--border-subtle, #444)',
                transition: 'all 0.3s ease',
              }}
            />
          ))}
        </div>

        {/* Visual */}
        <div style={{ textAlign: 'center', fontSize: '3rem', marginBottom: '1rem' }}>
          {(() => { const Visual = current.visual || current.icon; return <Visual size={44} /> })()}
        </div>

        {/* Content */}
        <div style={{ textAlign: 'center' }}>
          <h2 style={{
            fontSize: '1.35rem', fontWeight: 700,
            color: 'var(--text-primary)', marginBottom: '0.75rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <current.icon size={18} /> {t(`app.onboardingTour.${current.key}.title`)}
          </h2>
          <p style={{
            fontSize: '0.9rem', color: 'var(--text-secondary)',
            lineHeight: 1.6, marginBottom: '1.25rem',
          }}>
            {t(`app.onboardingTour.${current.key}.desc`)}
          </p>
          {current.code && (
            <div style={{
              background: 'var(--bg-primary, #111)',
              border: '1px solid var(--border-subtle, #333)',
              borderRadius: '0.5rem', padding: '0.75rem 1rem',
              fontFamily: 'monospace', fontSize: '0.8rem',
              color: 'var(--accent, #a78bfa)',
              textAlign: 'left', overflowX: 'auto',
              marginBottom: '0.5rem',
            }}>
              <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>$</span>
              {current.code}
            </div>
          )}
          {isLast && (
            <a
              href="https://docs.adhf.dev"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: '0.75rem', color: 'var(--accent, #a78bfa)', textDecoration: 'none' }}
            >
              {t('app.onboardingTour.learnMore')} →
            </a>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end items-center mt-6">
          <button
            onClick={() => isLast ? onClose() : setStep(s => s + 1)}
            className="btn btn-primary"
          >
            {isLast ? `${t('app.onboardingTour.getStarted')} →` : `${t('app.onboardingTour.next')} →`}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
    </ModalPortal>
  )
}
