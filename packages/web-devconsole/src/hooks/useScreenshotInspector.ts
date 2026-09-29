import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AppendOutput, Badge } from '../shared'
import type { InspectorTab } from '../components/CdpInspectorPanel'

/**
 * CDP screenshot + click-to-inspect + analyze state: the (live) screenshot,
 * the crosshair, and the Inspector / Analyze results the right panel shows.
 */
export function useScreenshotInspector(ideTarget: string, provider: string, appendOutput: AppendOutput, setBadge: (badge: Badge) => void) {
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [screenshotVp, setScreenshotVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [liveScreenshot, setLiveScreenshot] = useState(false)
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null)
  const [inspectResult, setInspectResult] = useState<any>(null)
  const [analyzeResult, setAnalyzeResult] = useState<any>(null)
  const [rightTab, setRightTab] = useState<InspectorTab>('inspector')
  const imgRef = useRef<HTMLImageElement>(null)

  // ─── Screenshot ───
  const screenshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const doCapture = useCallback(async () => {
    const result = await api.screenshot(ideTarget || undefined)
    if (result) {
      // Revoke old blob URL to avoid memory leak
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl)
      setScreenshotUrl(result.url)
      setScreenshotVp({ w: result.vpW, h: result.vpH })
    }
  }, [ideTarget, screenshotUrl])

  async function takeScreenshot() {
    setCrosshair(null)
    await doCapture()
  }

  function toggleLiveScreenshot() {
    if (liveScreenshot) {
      // Stop
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current)
      screenshotTimerRef.current = null
      setLiveScreenshot(false)
    } else {
      // Start
      doCapture()
      screenshotTimerRef.current = setInterval(doCapture, 2000)
      setLiveScreenshot(true)
    }
  }

  // Cleanup on unmount or provider change
  useEffect(() => {
    return () => {
      if (screenshotTimerRef.current) clearInterval(screenshotTimerRef.current)
    }
  }, [provider])

  // ─── Click-to-Inspect ───
  async function handleScreenshotClick(e: React.MouseEvent<HTMLImageElement>) {
    const img = imgRef.current
    const panel = (e.target as HTMLElement).closest('.screenshot-panel') as HTMLElement | null
    if (!img || !panel) return

    const panelRect = panel.getBoundingClientRect()
    const imgRect = img.getBoundingClientRect()

    // Click position within img
    const clickInImgX = e.clientX - imgRect.left
    const clickInImgY = e.clientY - imgRect.top
    if (clickInImgX < 0 || clickInImgY < 0 || clickInImgX > imgRect.width || clickInImgY > imgRect.height) return

    // Crosshair position relative to panel (simple, correct)
    setCrosshair({
      x: e.clientX - panelRect.left,
      y: e.clientY - panelRect.top
    })

    // Map to CSS viewport coordinates for elementFromPoint
    const vpW = screenshotVp.w || img.naturalWidth
    const vpH = screenshotVp.h || img.naturalHeight
    const px = Math.round((clickInImgX / imgRect.width) * vpW)
    const py = Math.round((clickInImgY / imgRect.height) * vpH)

    try {
      const result = await api.inspect({ x: px, y: py, ideType: ideTarget || undefined })
      if ((result as any).error) { appendOutput((result as any).error, 'error'); return }
      setInspectResult(result)
      setRightTab('inspector')
      const { element } = result as any
      appendOutput(`🔍 ${element.fullSelector}`, 'result'); setBadge('ok')
    } catch (err: any) { appendOutput('Inspect failed: ' + err.message, 'error') }
  }

  // ─── Analyze Element ───
  async function analyzeElement(selector?: string) {
    if (!selector && !inspectResult?.element?.fullSelector) {
      appendOutput('Click an element first, then analyze', 'warn')
      return
    }
    const sel = selector || inspectResult?.element?.fullSelector
    try {
      const result = await api.analyze({ selector: sel, ideType: ideTarget || undefined })
      setAnalyzeResult(result)
      setRightTab('analyze')
      const sibCount = result?.siblingPattern?.count || 0
      const ancestorCount = result?.ancestorAnalysis?.length || 0
      appendOutput(`🔬 Analyzed: ${sibCount > 0 ? `${sibCount} siblings found` : 'no sibling pattern'}, ${ancestorCount} ancestors scanned`, 'result')
    } catch (err: any) { appendOutput('Analyze failed: ' + err.message, 'error') }
  }

  return {
    screenshotUrl, liveScreenshot, crosshair, imgRef,
    inspectResult, analyzeResult, rightTab, setRightTab,
    takeScreenshot, toggleLiveScreenshot, handleScreenshotClick, analyzeElement,
  }
}
