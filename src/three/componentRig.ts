import * as THREE from 'three'
import type { AeroResult, SimulationParams } from '../types'

export const adjustableComponentIds = [
  'front-wing-mainplane',
  'front-wing-flap',
  'rear-wing-mainplane',
  'rear-wing-flap',
  'floor-throat',
  'floor-edge-left',
  'floor-edge-right',
  'diffuser',
] as const

export type AdjustableComponentId = typeof adjustableComponentIds[number]

export const componentManifest: ReadonlyArray<{
  id: AdjustableComponentId
  control: string
  hinge: 'fixed' | 'x-axis' | 'z-axis'
}> = [
  { id: 'front-wing-mainplane', control: 'frontWingAngleDeg', hinge: 'z-axis' },
  { id: 'front-wing-flap', control: 'frontFlapPercent', hinge: 'z-axis' },
  { id: 'rear-wing-mainplane', control: 'rearWingLoadPercent', hinge: 'z-axis' },
  { id: 'rear-wing-flap', control: 'activeAeroMode/drsOpen', hinge: 'z-axis' },
  { id: 'floor-throat', control: 'floorThroatSealPercent', hinge: 'fixed' },
  { id: 'floor-edge-left', control: 'floorEdgeSealPercent', hinge: 'x-axis' },
  { id: 'floor-edge-right', control: 'floorEdgeSealPercent', hinge: 'x-axis' },
  { id: 'diffuser', control: 'diffuserAngleDeg', hinge: 'z-axis' },
]

export type ComponentNodes = Record<AdjustableComponentId, THREE.Group>

/**
 * Semantic nodes exposed by a licensed reference asset. Reference files are
 * allowed to implement only a subset of the full analysis rig while the
 * remaining geometry stays static, so every entry is optional.
 */
export type SemanticComponentNodes = Partial<Record<AdjustableComponentId, THREE.Object3D>>

export type ComponentPose = {
  frontWingMainplaneRotationZ: number
  frontWingFlapRotationZ: number
  rearWingMainplaneRotationZ: number
  rearWingFlapRotationZ: number
  floorThroatScaleZ: number
  floorEdgeSpreadM: number
  floorEdgeRotationX: number
  diffuserRotationZ: number
}

export type CarPose = {
  positionY: number
  rotationZ: number
}

const degToRad = THREE.MathUtils.degToRad
export const analysisFloorGeometry = {
  centerX: -0.09,
  centerY: 0.2,
  length: 4.6,
  thickness: 0.075,
} as const
export const analysisRideHeightDatum = {
  frontX: -1.9,
  rearX: 1.72,
  localY: analysisFloorGeometry.centerY - analysisFloorGeometry.thickness / 2,
} as const
const ANALYSIS_WHEELBASE_M = analysisRideHeightDatum.rearX - analysisRideHeightDatum.frontX

export const resolveCarPose = (params: SimulationParams): CarPose => {
  const frontRideHeightM = params.garage.frontRideHeightMm / 1000
  const rearRideHeightM = params.garage.rearRideHeightMm / 1000
  const rotationZ = Math.asin(THREE.MathUtils.clamp(
    (rearRideHeightM - frontRideHeightM) / ANALYSIS_WHEELBASE_M,
    -1,
    1,
  ))
  return {
    positionY: frontRideHeightM
      - analysisRideHeightDatum.frontX * Math.sin(rotationZ)
      - analysisRideHeightDatum.localY * Math.cos(rotationZ),
    rotationZ,
  }
}

export const resolveReferenceFlowKey = (params: SimulationParams) => [
  params.ruleset,
  params.garage.frontWingAngleDeg,
  params.garage.frontFlapPercent,
  params.garage.rearWingLoadPercent,
  params.ruleset === '2026'
    ? `active:${params.driver.activeAeroMode}`
    : `drs:${params.garage.drsOpen ? 'open' : 'closed'}`,
].join(':')

export const resolveComponentPose = (
  params: SimulationParams,
  result: Pick<AeroResult, 'ruleset' | 'activeAeroMode' | 'drsActive'>,
): ComponentPose => {
  const lowDrag = result.ruleset === '2026'
    ? result.activeAeroMode === 'straight'
    : result.drsActive

  return {
    frontWingMainplaneRotationZ: degToRad((params.garage.frontWingAngleDeg - 12) * 0.6 - (lowDrag && result.ruleset === '2026' ? 4 : 0)),
    frontWingFlapRotationZ: degToRad((params.garage.frontFlapPercent - 48) * 0.12 - (lowDrag && result.ruleset === '2026' ? 5 : 0)),
    rearWingMainplaneRotationZ: degToRad((params.garage.rearWingLoadPercent - 56) * 0.12),
    // The flap carries most of a real rear-wing level change, so it follows the
    // load setting at the mainplane's rate while staying an independent element.
    rearWingFlapRotationZ: degToRad(lowDrag ? -12 : (params.garage.rearWingLoadPercent - 56) * 0.12),
    floorThroatScaleZ: THREE.MathUtils.lerp(0.92, 1.08, params.design.floorThroatSealPercent / 100),
    floorEdgeSpreadM: THREE.MathUtils.lerp(0.84, 0.98, params.design.floorEdgeSealPercent / 100),
    floorEdgeRotationX: degToRad(THREE.MathUtils.lerp(1.5, 7, params.design.floorEdgeSealPercent / 100)),
    diffuserRotationZ: degToRad(params.design.diffuserAngleDeg - 10),
  }
}

export const applyComponentPose = (
  nodes: ComponentNodes | SemanticComponentNodes,
  pose: ComponentPose,
) => {
  const frontWingMainplane = nodes['front-wing-mainplane']
  if (frontWingMainplane) frontWingMainplane.rotation.z = pose.frontWingMainplaneRotationZ
  const frontWingFlap = nodes['front-wing-flap']
  if (frontWingFlap) frontWingFlap.rotation.z = pose.frontWingFlapRotationZ
  const rearWingMainplane = nodes['rear-wing-mainplane']
  if (rearWingMainplane) rearWingMainplane.rotation.z = pose.rearWingMainplaneRotationZ
  const rearWingFlap = nodes['rear-wing-flap']
  if (rearWingFlap) rearWingFlap.rotation.z = pose.rearWingFlapRotationZ
  const floorThroat = nodes['floor-throat']
  if (floorThroat) floorThroat.scale.z = pose.floorThroatScaleZ
  const floorEdgeLeft = nodes['floor-edge-left']
  if (floorEdgeLeft) {
    floorEdgeLeft.position.z = pose.floorEdgeSpreadM
    floorEdgeLeft.rotation.x = pose.floorEdgeRotationX
  }
  const floorEdgeRight = nodes['floor-edge-right']
  if (floorEdgeRight) {
    floorEdgeRight.position.z = -pose.floorEdgeSpreadM
    floorEdgeRight.rotation.x = -pose.floorEdgeRotationX
  }
  const diffuser = nodes.diffuser
  if (diffuser) diffuser.rotation.z = pose.diffuserRotationZ
}
