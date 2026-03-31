import type { RefObject } from 'react'

interface RemoteCursorOverlayProps {
    cursorPos: { nx: number; ny: number } | null
    viewportRef: RefObject<HTMLDivElement>
    imgRef: RefObject<HTMLImageElement>
}

export default function RemoteCursorOverlay({
    cursorPos,
    viewportRef,
    imgRef,
}: RemoteCursorOverlayProps) {
    if (!cursorPos || !imgRef.current) return null

    const img = imgRef.current
    const rect = img.getBoundingClientRect()
    const viewRect = viewportRef.current?.getBoundingClientRect()
    if (!viewRect) return null

    const natW = img.naturalWidth || rect.width
    const natH = img.naturalHeight || rect.height
    const imgAspect = natW / natH
    const elemAspect = rect.width / rect.height

    let renderedW: number
    let renderedH: number
    let offsetX: number
    let offsetY: number

    if (imgAspect > elemAspect) {
        renderedW = rect.width
        renderedH = rect.width / imgAspect
        offsetX = 0
        offsetY = (rect.height - renderedH) / 2
    } else {
        renderedH = rect.height
        renderedW = rect.height * imgAspect
        offsetX = (rect.width - renderedW) / 2
        offsetY = 0
    }

    const cx = rect.left - viewRect.left + offsetX + renderedW * cursorPos.nx
    const cy = rect.top - viewRect.top + offsetY + renderedH * cursorPos.ny
    const clampedCx = Math.max(8, Math.min(viewRect.width - 8, cx))
    const clampedCy = Math.max(8, Math.min(viewRect.height - 8, cy))

    return (
        <div style={{
            position: 'absolute',
            left: clampedCx - 8,
            top: clampedCy - 8,
            width: 16,
            height: 16,
            pointerEvents: 'none',
            zIndex: 100,
        }}>
            <div style={{ position: 'absolute', left: 7, top: 0, width: 2, height: 16, background: 'rgba(59,130,246,0.8)' }} />
            <div style={{ position: 'absolute', left: 0, top: 7, width: 16, height: 2, background: 'rgba(59,130,246,0.8)' }} />
            <div style={{
                position: 'absolute',
                left: 5,
                top: 5,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#3b82f6',
                boxShadow: '0 0 8px rgba(59,130,246,0.6)',
            }} />
        </div>
    )
}
