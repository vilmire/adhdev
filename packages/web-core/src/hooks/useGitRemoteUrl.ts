import { useEffect, useRef, useState } from 'react'
import { useTransport } from '../context/TransportContext'

export function useGitRemoteUrl(daemonId: string | null | undefined, workspace: string | null | undefined): {
    remoteUrl: string | null
    githubUrl: string | null
    loading: boolean
} {
    const { sendCommand } = useTransport()
    const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const requestSeqRef = useRef(0)

    useEffect(() => {
        const requestSeq = requestSeqRef.current + 1
        requestSeqRef.current = requestSeq
        setRemoteUrl(null)
        if (!daemonId || !workspace) {
            setLoading(false)
            return
        }
        setLoading(true)
        void sendCommand(daemonId, 'git_remote_url', { workspace }).then((res) => {
            if (requestSeqRef.current !== requestSeq) return
            const body = res?.result ?? res
            setRemoteUrl(typeof body?.remoteUrl === 'string' ? body.remoteUrl : null)
        }).catch(() => {
            if (requestSeqRef.current !== requestSeq) return
            setRemoteUrl(null)
        }).finally(() => {
            if (requestSeqRef.current !== requestSeq) return
            setLoading(false)
        })
        return () => {
            requestSeqRef.current += 1
        }
    }, [daemonId, workspace, sendCommand])

    const githubUrl = extractGitHubUrl(remoteUrl)
    return { remoteUrl, githubUrl, loading }
}

export function extractGitHubUrl(remoteUrl: string | null | undefined): string | null {
    if (!remoteUrl) return null
    // SSH: git@github.com:owner/repo.git → https://github.com/owner/repo
    const sshMatch = remoteUrl.match(/git@github\.com[:/](.+?)(?:\.git)?$/)
    if (sshMatch) return `https://github.com/${sshMatch[1]}`
    // HTTPS: https://github.com/owner/repo(.git)
    const httpsMatch = remoteUrl.match(/https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}`
    return null
}
