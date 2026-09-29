import { useCallback, useRef, useState } from 'react'
import { ICONS, ts, type Badge, type OutputEntry, type OutputType } from '../shared'

/** The Output panel's log: entries, the OK/ERROR badge, and the previous result for the diff view. */
export function useOutput() {
  const [output, setOutput] = useState<OutputEntry[]>([])
  const [badge, setBadge] = useState<Badge>(null)
  // #4 Output diff — the last result before the newest one
  const [prevOutput, setPrevOutput] = useState<string | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(0)

  const appendOutput = useCallback((text: string, type: OutputType) => {
    const entry: OutputEntry = { id: nextId.current++, time: ts(), icon: ICONS[type], text, type }
    setOutput(prev => {
      // #4 Save last result for diff
      const lastResult = prev.filter(e => e.type === 'result').pop()
      if (lastResult && type === 'result') setPrevOutput(lastResult.text)
      return [...prev, entry]
    })
    setTimeout(() => { outputRef.current?.scrollTo(0, outputRef.current.scrollHeight) }, 50)
  }, [])

  const clearOutput = useCallback(() => {
    setOutput([]); setBadge(null); setPrevOutput(null)
  }, [])

  return { output, badge, setBadge, prevOutput, outputRef, appendOutput, clearOutput }
}
