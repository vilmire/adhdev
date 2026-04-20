import { useState } from 'react'
import { IconX } from './Icons'

interface OnboardingModalProps {
  onClose: () => void
}

const STEPS = [
  {
    icon: '🦦',
    title: 'Welcome to ADHDev',
    desc: 'Monitor and control your AI coding agents from anywhere — web, mobile, or CLI.',
    visual: '🎉',
  },
  {
    icon: '💬',
    title: 'Real-time chat',
    desc: 'See what your AI agent is doing in real-time. Send messages, approve or reject actions — all from your browser or phone.',
    visual: '📱',
  },
  {
    icon: '🖥️',
    title: 'Remote desktop',
    desc: 'View and control your IDE screen via P2P connection. Click, type, scroll — just like being there.',
    visual: '🖱️',
  },
  {
    icon: '🚀',
    title: 'Get started',
    desc: 'Install the daemon and link it to your dashboard. It connects automatically.',
    code: 'npm install -g @adhdev/daemon-standalone && adhdev-standalone',
  },
]

export default function OnboardingModal({ onClose }: OnboardingModalProps) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <div
      className="onboarding-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
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
          padding: '2.5rem 2rem 2rem',
          position: 'relative',
          animation: 'slideUp 0.3s ease-out',
        }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 right-4 bg-transparent border-none text-text-muted hover:text-text-primary transition-colors cursor-pointer"
        ><IconX size={20} /></button>

        {/* Step indicator */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: '1.5rem' }}>
          {STEPS.map((_, i) => (
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
          {current.visual || current.icon}
        </div>

        {/* Content */}
        <div style={{ textAlign: 'center' }}>
          <h2 style={{
            fontSize: '1.35rem', fontWeight: 700,
            color: 'var(--text-primary)', marginBottom: '0.75rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <span>{current.icon}</span> {current.title}
          </h2>
          <p style={{
            fontSize: '0.9rem', color: 'var(--text-secondary)',
            lineHeight: 1.6, marginBottom: '1.25rem',
          }}>
            {current.desc}
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
              📚 Learn more in the docs →
            </a>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end items-center mt-6">
          <button
            onClick={() => isLast ? onClose() : setStep(s => s + 1)}
            className="btn btn-primary"
          >
            {isLast ? 'Get Started →' : 'Next →'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
  )
}
