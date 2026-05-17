import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it } from 'vitest'
import MeshObservabilitySurface from '../../src/components/MeshGraph/MeshObservabilitySurface'
import { buildMeshGraph } from '../../src/utils/mesh-visualization'

function renderSurface(status: any): string {
  const graph = buildMeshGraph(status)
  return renderToString(
    React.createElement(
      StaticRouter,
      { location: '/' },
      React.createElement(MeshObservabilitySurface, { graph: graph as any, status: status as any }),
    ),
  )
}

describe('MeshObservabilitySurface', () => {
  it('renders even when preview/cloud mesh_status payload omits queue and ledger summaries', () => {
    const status = {
      meshId: 'mesh_preview',
      meshName: 'Preview Mesh',
      repoIdentity: 'repo',
      refreshedAt: '2026-05-17T00:00:00.000Z',
      nodes: [],
      queue: { tasks: [] },
      ledger: { entries: [] },
    }

    expect(() => renderSurface(status)).not.toThrow()
    const html = renderSurface(status)
    expect(html).toContain('0 active queue')
    expect(html).toContain('0 recent failures')
  })
})
