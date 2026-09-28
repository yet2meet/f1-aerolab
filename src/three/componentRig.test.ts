import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cars, defaultParams } from '../data/cars'
import { calculateAero } from '../lib/aero'
import {
  adjustableComponentIds,
  analysisRideHeightDatum,
  applyComponentPose,
  componentManifest,
  type ComponentNodes,
  type SemanticComponentNodes,
  resolveCarPose,
  resolveComponentPose,
  resolveReferenceComponentPose,
  resolveReferenceFlowKey,
  REFERENCE_FRONT_ANGLE_FLAP_GAIN,
} from './componentRig'

const setup = () => {
  const car = cars[0]
  const params = defaultParams(car)
  const result = calculateAero(car, params)
  return { car, params, result }
}

const createNodes = () => Object.fromEntries(
  adjustableComponentIds.map((id) => {
    const node = new THREE.Group()
    node.name = id
    return [id, node]
  }),
) as ComponentNodes

const snapshot = (nodes: ComponentNodes) => Object.fromEntries(
  adjustableComponentIds.map((id) => {
    const node = nodes[id]
    return [id, {
      position: node.position.toArray(),
      rotation: node.rotation.toArray(),
      scale: node.scale.toArray(),
    }]
  }),
)

const rideHeightDatumY = (pose: ReturnType<typeof resolveCarPose>, x: number) => (
  pose.positionY
    + x * Math.sin(pose.rotationZ)
    + analysisRideHeightDatum.localY * Math.cos(pose.rotationZ)
)

describe('explicit aerodynamic component rig', () => {
  it('has one unique manifest entry and named node per adjustable component', () => {
    const nodes = createNodes()

    expect(new Set(componentManifest.map(({ id }) => id)).size).toBe(adjustableComponentIds.length)
    adjustableComponentIds.forEach((id) => expect(nodes[id].name).toBe(id))
  })

  it('changes only the front mainplane for a front-wing attack adjustment', () => {
    const { params, result } = setup()
    const nodes = createNodes()
    applyComponentPose(nodes, resolveComponentPose(params, result))
    const before = snapshot(nodes)

    params.garage.frontWingAngleDeg += 6
    applyComponentPose(nodes, resolveComponentPose(params, result))
    const after = snapshot(nodes)

    expect(after['front-wing-mainplane']).not.toEqual(before['front-wing-mainplane'])
    adjustableComponentIds
      .filter((id) => id !== 'front-wing-mainplane')
      .forEach((id) => expect(after[id]).toEqual(before[id]))
  })

  it('opens only the rear flap for legacy DRS', () => {
    const car = cars.find(({ ruleset }) => ruleset === '2022-2025')!
    const params = defaultParams(car)
    const nodes = createNodes()
    let result = calculateAero(car, params)
    applyComponentPose(nodes, resolveComponentPose(params, result))
    const before = snapshot(nodes)

    params.garage.drsOpen = true
    result = calculateAero(car, params)
    applyComponentPose(nodes, resolveComponentPose(params, result))
    const after = snapshot(nodes)

    expect(after['rear-wing-flap']).not.toEqual(before['rear-wing-flap'])
    adjustableComponentIds
      .filter((id) => id !== 'rear-wing-flap')
      .forEach((id) => expect(after[id]).toEqual(before[id]))
  })

  it('safely applies an absolute pose to a partial semantic node map', () => {
    const { params, result } = setup()
    const mainplane = new THREE.Group()
    const nodes: SemanticComponentNodes = { 'front-wing-mainplane': mainplane }
    const pose = resolveComponentPose(params, result)

    expect(() => applyComponentPose(nodes, pose)).not.toThrow()
    expect(mainplane.rotation.z).toBe(pose.frontWingMainplaneRotationZ)
  })

  it('turns the rear flap with the rear load setting while it stays an independent node', () => {
    const { params, result } = setup()
    params.garage.rearWingLoadPercent = 56
    const neutral = resolveComponentPose(params, { ...result, drsActive: false, activeAeroMode: 'corner' })
    params.garage.rearWingLoadPercent = 100
    const loaded = resolveComponentPose(params, { ...result, drsActive: false, activeAeroMode: 'corner' })

    expect(THREE.MathUtils.radToDeg(loaded.rearWingFlapRotationZ - neutral.rearWingFlapRotationZ)).toBeCloseTo(44 * 0.12, 6)
    expect(loaded.frontWingFlapRotationZ).toBe(neutral.frontWingFlapRotationZ)
  })

  it('turns the reference front flap, not the mainplane, for the front-wing angle', () => {
    const { params, result } = setup()
    params.garage.frontWingAngleDeg = 12
    const neutral = resolveReferenceComponentPose(params, result)
    params.garage.frontWingAngleDeg = 25
    const steep = resolveReferenceComponentPose(params, result)

    expect(steep.frontWingMainplaneRotationZ).toBeCloseTo(neutral.frontWingMainplaneRotationZ, 10)
    expect(THREE.MathUtils.radToDeg(steep.frontWingFlapRotationZ - neutral.frontWingFlapRotationZ))
      .toBeCloseTo(13 * REFERENCE_FRONT_ANGLE_FLAP_GAIN, 6)
    const analysis = resolveComponentPose(params, result)
    expect(steep.rearWingFlapRotationZ).toBe(analysis.rearWingFlapRotationZ)
  })

  it('keeps the reference mainplane active-aero offset', () => {
    const { params, result } = setup()
    params.ruleset = '2026'
    params.driver.activeAeroMode = 'straight'
    const pose = resolveReferenceComponentPose(params, { ...result, ruleset: '2026', activeAeroMode: 'straight' })
    expect(THREE.MathUtils.radToDeg(pose.frontWingMainplaneRotationZ)).toBeCloseTo(-4, 6)
  })

  it('keeps chassis pose independent from every aero component input', () => {
    const { params } = setup()
    const before = resolveCarPose(params)

    params.garage.frontWingAngleDeg = 25
    params.garage.frontFlapPercent = 100
    params.garage.rearWingLoadPercent = 100
    params.garage.drsOpen = true
    params.design.floorThroatSealPercent = 100
    params.design.floorEdgeSealPercent = 100
    params.design.diffuserAngleDeg = 15

    expect(resolveCarPose(params)).toEqual(before)
  })

  it('maps the displayed ride heights to absolute floor-datum clearances', () => {
    const { params } = setup()
    const defaultPose = resolveCarPose(params)
    let pose = defaultPose
    expect(rideHeightDatumY(pose, analysisRideHeightDatum.frontX)).toBeCloseTo(0.028, 8)
    expect(rideHeightDatumY(pose, analysisRideHeightDatum.rearX)).toBeCloseTo(0.042, 8)

    params.garage.frontRideHeightMm += 10
    pose = resolveCarPose(params)
    expect(pose.rotationZ).toBeLessThan(defaultPose.rotationZ)
    expect(rideHeightDatumY(pose, analysisRideHeightDatum.frontX)).toBeCloseTo(0.038, 8)
    expect(rideHeightDatumY(pose, analysisRideHeightDatum.rearX)).toBeCloseTo(0.042, 8)
  })

  it.each([
    [15, 20],
    [70, 90],
    [15, 90],
    [70, 20],
  ])('keeps %i/%i mm boundary inputs exact at both floor datums', (frontMm, rearMm) => {
    const { params } = setup()
    params.garage.frontRideHeightMm = frontMm
    params.garage.rearRideHeightMm = rearMm

    const pose = resolveCarPose(params)
    expect(rideHeightDatumY(pose, analysisRideHeightDatum.frontX)).toBeCloseTo(frontMm / 1000, 8)
    expect(rideHeightDatumY(pose, analysisRideHeightDatum.rearX)).toBeCloseTo(rearMm / 1000, 8)
  })

  it('rebuilds reference-flow geometry for adjustable wing and active-aero controls', () => {
    const { params } = setup()
    const before = resolveReferenceFlowKey(params)

    params.garage.frontWingAngleDeg = 25
    params.garage.frontFlapPercent = 100
    params.garage.rearWingLoadPercent = 100
    params.driver.activeAeroMode = 'straight'

    expect(resolveReferenceFlowKey(params)).not.toBe(before)
  })

  it('keeps reference-flow geometry fixed for controls without reference-model geometry', () => {
    const { params } = setup()
    const before = resolveReferenceFlowKey(params)

    params.run.massKg = 900
    params.garage.tirePressurePsi = 28
    params.driver.brakeBiasFrontPercent = 60
    params.design.floorThroatSealPercent = 100
    params.design.floorEdgeSealPercent = 100
    params.design.diffuserAngleDeg = 15

    expect(resolveReferenceFlowKey(params)).toBe(before)
  })

  it('keys only the active-aero control supported by the selected ruleset', () => {
    const { params } = setup()
    params.ruleset = '2026'
    const activeAeroBefore = resolveReferenceFlowKey(params)
    params.garage.drsOpen = !params.garage.drsOpen
    expect(resolveReferenceFlowKey(params)).toBe(activeAeroBefore)
    params.driver.activeAeroMode = 'straight'
    expect(resolveReferenceFlowKey(params)).not.toBe(activeAeroBefore)

    params.ruleset = '2022-2025'
    const drsBefore = resolveReferenceFlowKey(params)
    params.driver.activeAeroMode = 'corner'
    expect(resolveReferenceFlowKey(params)).toBe(drsBefore)
    params.garage.drsOpen = !params.garage.drsOpen
    expect(resolveReferenceFlowKey(params)).not.toBe(drsBefore)
  })
})
