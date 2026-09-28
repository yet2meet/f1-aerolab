import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  applySurfaceFlowDelta,
  buildSurfaceFlow,
  captureSurfaceFlowSnapshot,
  setSurfaceFlowBaselineStyle,
  setSurfaceFlowOpacity,
  updateSurfaceFlow,
  type SurfaceFlowRig,
} from './surfaceFlow'

const rigs: SurfaceFlowRig[] = []

const createFlow = () => {
  const body = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 1.8))
  body.position.y = 0.55
  body.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(body)
  const rig = buildSurfaceFlow([body], bounds)
  rigs.push(rig)
  body.geometry.dispose()
  return rig
}

afterEach(() => {
  rigs.splice(0).forEach((rig) => rig.dispose())
})

describe('surface flow', () => {
  it('builds smoke layers and directional tracers from the supplied mesh', () => {
    const rig = createFlow()

    expect(rig.layerCount).toBe(5)
    expect(rig.tracers).toHaveLength(12)
    expect(rig.sampleCount).toBeGreaterThan(1_000)
    expect(rig.group.getObjectsByProperty('name', 'continuous-volumetric-wind-sheet')).toHaveLength(5)
    expect(rig.group.getObjectsByProperty('name', 'smoke-embedded-flow-tracer')).toHaveLength(12)
    expect(rig.group.getObjectsByProperty('name', 'smoke-embedded-flow-pulse')).toHaveLength(12)
  })

  it('keeps tracers clear of the body without spiking over narrow obstacles', () => {
    const body = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 1.8))
    body.position.y = 0.4
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 1.8))
    post.position.set(0, 0.9, 0)
    const model = new THREE.Group()
    model.add(body, post)
    model.updateMatrixWorld(true)
    const rig = buildSurfaceFlow([body, post], new THREE.Box3().setFromObject(model))
    rigs.push(rig)

    const upper = rig.tracers.filter(({ region }) => region === 'upper')
    upper.forEach(({ curve }) => {
      const onBody = curve.points.filter((point) => Math.abs(point.x) < 1.9)
      onBody.forEach((point) => expect(point.y).toBeGreaterThanOrEqual(0.6))
      const steps = curve.points.slice(1).map((point, index) => Math.abs(point.y - curve.points[index].y))
      expect(Math.max(...steps)).toBeLessThan(0.3)
    })
    body.geometry.dispose()
    post.geometry.dispose()
  })

  it('lifts the upper wake behind the last surface instead of dropping it', () => {
    const rig = createFlow()
    rig.tracers.filter(({ region }) => region === 'upper').forEach(({ curve }) => {
      const points = curve.points
      const outlet = points[points.length - 1]
      const trailingEdge = points.find((point) => point.x > 2.05) as THREE.Vector3
      expect(outlet.y).toBeGreaterThan(trailingEdge.y)
    })
  })

  it('increases smoke strength and tracer travel with speed', () => {
    const rig = createFlow()
    const geometryBefore = rig.tracers.map(({ curve }) => curve.points.map((point) => point.toArray()))

    updateSurfaceFlow(rig, 2, 0, false)
    const slowPosition = rig.tracers[0].marker.position.clone()
    expect(rig.materials[0].uniforms.uFlowStrength.value).toBeCloseTo(0.18)

    updateSurfaceFlow(rig, 2, 300, false)
    expect(rig.materials[0].uniforms.uFlowStrength.value).toBeCloseTo(1)
    expect(rig.tracers[0].pulse.material.uniforms.uTravel.value).toBeGreaterThan(0)
    expect(rig.materials[0].uniforms.uSpeed.value).toBeGreaterThan(1)
    expect(rig.tracers[0].marker.position.distanceTo(slowPosition)).toBeGreaterThan(0.01)
    expect(rig.tracers.map(({ curve }) => curve.points.map((point) => point.toArray())))
      .toEqual(geometryBefore)
  })

  it('fades smoke and embedded tracers with one transition value', () => {
    const rig = createFlow()
    const tracer = rig.group.getObjectByName('smoke-embedded-flow-tracer') as THREE.Mesh
    const marker = rig.group.getObjectByName('smoke-embedded-flow-marker') as THREE.Mesh
    const tracerMaterial = tracer.material as THREE.MeshBasicMaterial
    const markerMaterial = marker.material as THREE.MeshBasicMaterial

    setSurfaceFlowOpacity(rig, 0.35)

    expect(rig.materials[0].uniforms.uTransition.value).toBeCloseTo(0.35)
    expect(tracerMaterial.opacity).toBeCloseTo(0.58 * 0.35)
    expect(markerMaterial.opacity).toBeCloseTo(0.9 * 0.35)
    expect(rig.pulseMaterials[0].uniforms.uTransition.value).toBeCloseTo(0.35)
  })

  it('resamples the path geometry after an aerodynamic surface moves', () => {
    const body = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 1.8))
    body.position.y = 0.5
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 1.7))
    wing.position.set(-1.25, 1.25, 0)
    const model = new THREE.Group()
    model.add(body, wing)
    model.updateMatrixWorld(true)

    const fixedBounds = new THREE.Box3().setFromObject(model)
    const rest = buildSurfaceFlow([body, wing], fixedBounds)
    rigs.push(rest)
    const restPaths = rest.tracers.map(({ curve }) => curve.points.map((point) => point.toArray()))

    wing.rotation.z = THREE.MathUtils.degToRad(24)
    model.updateMatrixWorld(true)
    const moved = buildSurfaceFlow([body, wing], fixedBounds)
    rigs.push(moved)
    const movedPaths = moved.tracers.map(({ curve }) => curve.points.map((point) => point.toArray()))

    expect(movedPaths).not.toEqual(restPaths)
    body.geometry.dispose()
    wing.geometry.dispose()
  })

  it('reports zero delta for identical stable samples', () => {
    const baseline = createFlow()
    const current = createFlow()

    const delta = applySurfaceFlowDelta(
      current,
      captureSurfaceFlowSnapshot(baseline),
      'global',
      3,
    )

    expect(delta).toEqual({ maxOffsetM: 0, meanOffsetM: 0, affectedSamples: 0 })
    current.fields.forEach(({ geometry }) => {
      const values = (geometry.getAttribute('flowDelta') as THREE.BufferAttribute).array
      expect(Math.max(...values)).toBe(0)
    })
  })

  it('turns measured wing displacement into downstream heat without changing the measurement', () => {
    const body = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 1.8))
    body.position.y = 0.5
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 1.7))
    wing.position.set(-1.25, 1.25, 0)
    const model = new THREE.Group()
    model.add(body, wing)
    model.updateMatrixWorld(true)
    const fixedBounds = new THREE.Box3().setFromObject(model)
    const baseline = buildSurfaceFlow([body, wing], fixedBounds)
    rigs.push(baseline)

    wing.rotation.z = THREE.MathUtils.degToRad(24)
    model.updateMatrixWorld(true)
    const current = buildSurfaceFlow([body, wing], fixedBounds)
    rigs.push(current)
    const snapshot = captureSurfaceFlowSnapshot(baseline)
    const wrongFocus = applySurfaceFlowDelta(current, snapshot, 'rear-wing', 3)
    const normal = applySurfaceFlowDelta(current, snapshot, 'front-wing', 1)
    const amplified = applySurfaceFlowDelta(current, snapshot, 'front-wing', 3)

    expect(wrongFocus.affectedSamples).toBe(0)
    expect(normal.maxOffsetM).toBeGreaterThan(0)
    expect(amplified.maxOffsetM).toBeCloseTo(normal.maxOffsetM)
    expect(amplified.affectedSamples).toBeGreaterThan(0)
    expect(current.fields.some(({ geometry }) => {
      const values = (geometry.getAttribute('flowDelta') as THREE.BufferAttribute).array
      return Math.max(...values) > 0
    })).toBe(true)
    body.geometry.dispose()
    wing.geometry.dispose()
  })

  it('renders the previous field as a muted baseline without retaining old heat', () => {
    const rig = createFlow()
    const field = rig.fields[0]
    const tracer = rig.tracers[0]
    const count = (field.geometry.getAttribute('position') as THREE.BufferAttribute).count
    field.geometry.setAttribute('flowDelta', new THREE.Float32BufferAttribute(new Float32Array(count).fill(1), 1))

    setSurfaceFlowBaselineStyle(rig)
    setSurfaceFlowBaselineStyle(rig)
    setSurfaceFlowOpacity(rig, 1)

    expect(rig.materials[0].uniforms.uColor.value.getHex()).toBe(0x8d91b8)
    expect(Math.max(...(field.geometry.getAttribute('flowDelta') as THREE.BufferAttribute).array)).toBe(0)
    expect(tracer.path.material.opacity).toBeCloseTo(tracer.pathBaseOpacity * 0.42)
    expect(tracer.pulse.material.uniforms.uColor.value.getHex()).toBe(0x8d91b8)
  })
})
