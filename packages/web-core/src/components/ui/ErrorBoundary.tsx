import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { IconWarning } from '../Icons'

interface Props {
    children: ReactNode
}

interface State {
    hasError: boolean
    error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error }
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('[ErrorBoundary] Uncaught error:', error, errorInfo)
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    minHeight: '100vh',
                    background: 'var(--bg-primary, #0a0e1a)',
                    color: 'var(--text-secondary, #c4c9d4)',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                }}>
                    <div style={{ textAlign: 'center', maxWidth: 420, padding: 24 }}>
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                            <IconWarning size={44} className="text-status-warning" />
                        </div>
                        <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600, color: 'var(--text-primary, #eee)' }}>
                            Something went wrong
                        </h2>
                        <p style={{ margin: '0 0 20px', fontSize: 14, opacity: 0.7, lineHeight: 1.5 }}>
                            An unexpected error occurred. Please reload the page to continue.
                        </p>
                        <button
                            onClick={() => window.location.reload()}
                            style={{
                                padding: '10px 24px',
                                borderRadius: 8,
                                border: '1px solid rgba(99, 102, 241, 0.4)',
                                background: 'rgba(99, 102, 241, 0.1)',
                                color: '#a5b4fc',
                                fontSize: 14,
                                fontWeight: 500,
                                cursor: 'pointer',
                            }}
                        >
                            Reload page
                        </button>
                    </div>
                </div>
            )
        }

        return this.props.children
    }
}
