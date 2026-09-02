import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cars, defaultParams } from '../data/cars'
import { calculateAero } from '../lib/aero'
import { adjustableComponentIds, applyComponentPose, resolveCarPose, resolveComponentPose } from '../three/componentRig'
import { disposeObject3D } from '../three/highDetailCar'
import {
  buildCar,
  applyAnalysisChassisPose,
  resolveActiveComponentNodes,
  resolveFlowChangeFocus,
  resolveModelVisibility,
  type CarRig,
} from './WindTunnelView'

const rigs: CarRig[] = []

const createRig = () => {
  const rig = buildCar()
  rigs.push(rig)
  return rig
}

const worldMatrix = (object: THREE.Object3D) => object.matrixWorld.toArray()

afterEach(() => {
  rigs.splice(0).forEach(({ root }) => disposeObject3D(root))
})

describe('parameterized analysis car', () => {
  it('mounts every adjustable surface on the independently posed chassis', () => {
    const rig = createRig()

    adjustableComponentIds.forEach((id) => {
      expect(rig.componentNodes[id].name).toBe(id)
      expect(rig.componentNodes[id].parent).toBe(rig.chassis)
    })
    rig.wheels.forEach((wheel) => expect(wheel.parent).toBe(rig.root))
    rig.suspensionLinks.forEach(({ mesh }) => expect(mesh.parent).toBe(rig.root))
  })

  it('changes chassis heave and pitch without moving the wheel contact geometry', () => {
    const params = defaultParams(cars[0])
    const rig = createRig()
    applyAnalysisChassisPose(rig, resolveCarPose(params))
    rig.root.updateMatrixWorld(true)
    const rootBefore = worldMatrix(rig.root)
    const wheelsBefore = rig.wheels.map(worldMatrix)
    const chassisBefore = worldMatrix(rig.chassis)

    params.garage.frontRideHeightMm += 20
    applyAnalysisChassisPose(rig, resolveCarPose(params))
    rig.root.updateMatrixWorld(true)

    expect(worldMatrix(rig.root)).toEqual(rootBefore)
    expect(rig.wheels.map(worldMatrix)).toEqual(wheelsBefore)
    expect(worldMatrix(rig.chassis)).not.toEqual(chassisBefore)
  })

  it('keeps suspension wheel anchors fixed while chassis anchors follow the sprung body', () => {
    const params = defaultParams(cars[0])
    const rig = createRig()
    applyAnalysisChassisPose(rig, resolveCarPose(params))
    const fixedAnchorsBefore = rig.suspensionLinks.map(({ fixedAnchor }) => fixedAnchor.toArray())
    const chassisEndsBefore = rig.suspensionLinks.map(({ chassisEnd }) => chassisEnd.toArray())

    params.garage.frontRideHeightMm += 20
    applyAnalysisChassisPose(rig, resolveCarPose(params))

    expect(rig.suspensionLinks.map(({ fixedAnchor }) => fixedAnchor.toArray())).toEqual(fixedAnchorsBefore)
    expect(rig.suspensionLinks.map(({ chassisEnd }) => chassisEnd.toArray())).not.toEqual(chassisEndsBefore)
    rig.suspensionLinks.forEach(({ mesh, fixedAnchor, chassisEnd }) => {
      const expectedMidpoint = fixedAnchor.clone().add(chassisEnd).multiplyScalar(0.5)
      expect(mesh.position.distanceTo(expectedMidpoint)).toBeLessThan(1e-9)
      expect(mesh.scale.y).toBeCloseTo(fixedAnchor.distanceTo(chassisEnd), 9)
    })
  })

  it.each([
    [15, 20],
    [70, 90],
    [15, 90],
    [70, 20],
  ])('keeps the sprung geometry above ground at %i/%i mm', (frontMm, rearMm) => {
    const params = defaultParams(cars[0])
    const rig = createRig()
    params.garage.frontRideHeightMm = frontMm
    params.garage.rearRideHeightMm = rearMm

    applyAnalysisChassisPose(rig, resolveCarPose(params))
    rig.root.updateMatrixWorld(true)

    expect(new THREE.Box3().setFromObject(rig.chassis).min.y).toBeGreaterThanOrEqual(0)
  })

  it('keeps the chassis, wheels, flap and remaining surfaces fixed when the front mainplane changes', () => {
    const car = cars[0]
    const params = defaultParams(car)
    const result = calculateAero(car, params)
    const rig = createRig()

    applyComponentPose(rig.componentNodes, resolveComponentPose(params, result))
    rig.root.updateMatrixWorld(true)
    const rootBefore = worldMatrix(rig.root)
    const wheelMatricesBefore = rig.wheels.map(worldMatrix)
    const componentMatricesBefore = Object.fromEntries(
      adjustableComponentIds.map((id) => [id, worldMatrix(rig.componentNodes[id])]),
    )

    params.garage.frontWingAngleDeg += 6
    applyComponentPose(rig.componentNodes, resolveComponentPose(params, result))
    rig.root.updateMatrixWorld(true)

    expect(worldMatrix(rig.root)).toEqual(rootBefore)
    expect(rig.wheels.map(worldMatrix)).toEqual(wheelMatricesBefore)
    expect(worldMatrix(rig.componentNodes['front-wing-mainplane']))
      .not.toEqual(componentMatricesBefore['front-wing-mainplane'])
    adjustableComponentIds
      .filter((id) => id !== 'front-wing-mainplane')
      .forEach((id) => expect(worldMatrix(rig.componentNodes[id])).toEqual(componentMatricesBefore[id]))
  })
})

describe('analysis and reference visibility', () => {
  it('shows exactly one model and falls back to analysis until the reference is available', () => {
    expect(resolveModelVisibility('analysis', false)).toEqual({ analysis: true, reference: false })
    expect(resolveModelVisibility('analysis', true)).toEqual({ analysis: true, reference: false })
    expect(resolveModelVisibility('reference', false)).toEqual({ analysis: true, reference: false })
    expect(resolveModelVisibility('reference', true)).toEqual({ analysis: false, reference: true })
  })

  it('uses reference semantic nodes only when their complete capability is available', () => {
    const analysis = createRig().componentNodes
    const reference = { 'front-wing-mainplane': new THREE.Group() }

    expect(resolveActiveComponentNodes('reference', analysis, reference, true)).toBe(reference)
    expect(resolveActiveComponentNodes('reference', analysis, reference, false)).toBe(analysis)
    expect(resolveActiveComponentNodes('analysis', analysis, reference, true)).toBe(analysis)
  })
})

describe('reference flow change focus', () => {
  it('only rebuilds heat focus for controls that move real wing geometry', () => {
    const base = defaultParams(cars[0])
    const mass = { ...base, run: { ...base.run, massKg: base.run.massKg + 10 } }
    const front = { ...base, garage: { ...base.garage, frontWingAngleDeg: base.garage.frontWingAngleDeg + 2 } }
    const rear = { ...base, garage: { ...base.garage, rearWingLoadPercent: base.garage.rearWingLoadPercent + 5 } }

    expect(resolveFlowChangeFocus(base, mass)).toBeNull()
    expect(resolveFlowChangeFocus(base, front)).toBe('front-wing')
    expect(resolveFlowChangeFocus(base, rear)).toBe('rear-wing')
  })

  it('marks 2026 coupled active aero as a front and rear change', () => {
    const base = defaultParams(cars[0])
    const active = {
      ...base,
      driver: {
        ...base.driver,
        activeAeroMode: base.driver.activeAeroMode === 'straight' ? 'corner' as const : 'straight' as const,
      },
    }

    expect(resolveFlowChangeFocus(base, active)).toBe('all-wings')
  })
})
