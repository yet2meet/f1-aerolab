import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {
  carModelCredits,
  disposeObject3D,
  loadHighDetailCar,
  rotateSemanticWheels,
  type CarModelCredit,
  type SemanticRigStatus,
  type SemanticWheelNodes,
} from '../three/highDetailCar'
import {
  applySurfaceFlowDelta,
  buildSurfaceFlow,
  captureSurfaceFlowSnapshot,
  setSurfaceFlowBaselineStyle,
  setSurfaceFlowOpacity,
  updateSurfaceFlow,
  type FlowChangeFocus,
  resolveLoadDrivenWakeUpwash,
  type SurfaceFlowRig,
  type SurfaceFlowSnapshot,
} from '../three/surfaceFlow'
import { createComponentChangeOverlay, type ComponentChangeOverlay } from '../three/componentHighlight'
import { rearWingLoadRatio } from '../lib/aero'
import {
  analysisFloorGeometry,
  analysisRideHeightDatum,
  applyComponentPose,
  resolveCarPose,
  resolveComponentPose,
  resolveReferenceFlowKey,
  type CarPose,
  type ComponentNodes,
  type SemanticComponentNodes,
} from '../three/componentRig'
import type { AeroResult, CarSpec, SimulationParams } from '../types'

type WindTunnelViewProps = {
  car: CarSpec
  params: SimulationParams
  result: AeroResult
  onReferenceCapabilityChange?: (capability: { referenceMode: boolean; wingAdjustable: boolean }) => void
}
type CameraView = 'orbit' | 'side' | 'front'
export type ModelMode = 'analysis' | 'reference'
const cameraViewLabels: Record<CameraView, string> = { orbit: '环绕', side: '侧视', front: '正视' }
const modelModeLabels: Record<ModelMode, string> = { analysis: '分析模型', reference: '参考模型' }
export type CarRig = {
  root: THREE.Group
  chassis: THREE.Group
  componentNodes: ComponentNodes
  accentMaterials: THREE.MeshStandardMaterial[]
  wheels: THREE.Group[]
  suspensionLinks: SuspensionLink[]
}
export type SuspensionLink = {
  mesh: THREE.Mesh
  fixedAnchor: THREE.Vector3
  chassisAnchor: THREE.Vector3
  chassisEnd: THREE.Vector3
}
type FlowLine = { curve: THREE.CatmullRomCurve3; arrow: THREE.Mesh; phase: number; speedFactor: number }
type AirflowRig = {
  group: THREE.Group
  lines: FlowLine[]
  floorLayer: THREE.Group
  upperLayer: THREE.Group
  wakeLayer: THREE.Group
}

const SURFACE_FLOW_TRANSITION_SECONDS = 0.28
const SURFACE_FLOW_BASELINE_HOLD_SECONDS = 4.5
const SURFACE_FLOW_BASELINE_FADE_SECONDS = 0.9

export const resolveFlowChangeFocus = (
  previous: SimulationParams,
  current: SimulationParams,
): FlowChangeFocus | null => {
  if (previous.ruleset !== current.ruleset) return 'all-wings'
  let frontChanged = previous.garage.frontWingAngleDeg !== current.garage.frontWingAngleDeg
    || previous.garage.frontFlapPercent !== current.garage.frontFlapPercent
  let rearChanged = previous.garage.rearWingLoadPercent !== current.garage.rearWingLoadPercent
  if (current.ruleset === '2026' && previous.driver.activeAeroMode !== current.driver.activeAeroMode) {
    frontChanged = true
    rearChanged = true
  }
  if (current.ruleset === '2022-2025' && previous.garage.drsOpen !== current.garage.drsOpen) {
    rearChanged = true
  }
  if (frontChanged && rearChanged) return 'all-wings'
  if (frontChanged) return 'front-wing'
  if (rearChanged) return 'rear-wing'
  return null
}

const flowFocusLabels: Record<FlowChangeFocus, string> = {
  'front-wing': '前翼及下游',
  'rear-wing': '尾翼及尾流',
  'all-wings': '前后翼及下游',
  global: '全车气流',
}

const roundedBox = (
  size: [number, number, number],
  material: THREE.Material,
  position: [number, number, number],
  radius = 0.025,
) => {
  const safeRadius = Math.min(radius, size[0] / 2, size[1] / 2, size[2] / 2)
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 3, safeRadius), material)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

const ellipsoid = (
  scale: [number, number, number],
  material: THREE.Material,
  position: [number, number, number],
  segments = 28,
) => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, Math.max(12, segments / 2)), material)
  mesh.scale.set(...scale)
  mesh.position.set(...position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

const rod = (start: THREE.Vector3, end: THREE.Vector3, radius: number, material: THREE.Material) => {
  const direction = end.clone().sub(start)
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 8), material)
  mesh.position.copy(start).add(end).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  mesh.castShadow = true
  return mesh
}

const poseRod = (mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3) => {
  const direction = end.clone().sub(start)
  mesh.position.copy(start).add(end).multiplyScalar(0.5)
  mesh.scale.y = direction.length()
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
}

const suspensionLink = (
  fixedAnchor: THREE.Vector3,
  chassisAnchor: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): SuspensionLink => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8), material)
  const link = {
    mesh,
    fixedAnchor: fixedAnchor.clone(),
    chassisAnchor: chassisAnchor.clone(),
    chassisEnd: chassisAnchor.clone(),
  }
  mesh.castShadow = true
  poseRod(mesh, link.fixedAnchor, link.chassisEnd)
  return link
}

const verticalPlate = (points: Array<[number, number]>, depth: number, material: THREE.Material) => {
  const shape = new THREE.Shape()
  points.forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y))
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false })
  geometry.translate(0, 0, -depth / 2)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

const wingBlade = (
  group: THREE.Group,
  position: [number, number, number],
  size: [number, number, number],
  angleDeg: number,
  material: THREE.Material,
) => {
  const blade = roundedBox(size, material, position, 0.025)
  blade.rotation.z = THREE.MathUtils.degToRad(angleDeg)
  group.add(blade)
}

const wheelAssembly = (
  x: number,
  side: number,
  tyreMaterial: THREE.Material,
  coverMaterial: THREE.Material,
  carbonMaterial: THREE.Material,
) => {
  const wheel = new THREE.Group()
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.38, 40), tyreMaterial)
  tyre.rotation.x = Math.PI / 2
  tyre.castShadow = true
  wheel.add(tyre)
  const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.392, 32), coverMaterial)
  cover.rotation.x = Math.PI / 2
  cover.castShadow = true
  wheel.add(cover)
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.405, 20), carbonMaterial)
  hub.rotation.x = Math.PI / 2
  wheel.add(hub)
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xe2d63d })
  for (const ringSide of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.405, 0.018, 6, 40), ringMaterial)
    ring.position.z = ringSide * 0.198
    wheel.add(ring)
  }
  wheel.position.set(x, 0.5, side * 1.08)
  return wheel
}

export const resolveModelVisibility = (mode: ModelMode, referenceAvailable: boolean) => {
  const reference = mode === 'reference' && referenceAvailable
  return { analysis: !reference, reference }
}

export const resolveActiveComponentNodes = (
  mode: ModelMode,
  analysisNodes: ComponentNodes,
  referenceNodes: SemanticComponentNodes,
  referenceRigAvailable: boolean,
): ComponentNodes | SemanticComponentNodes => (
  mode === 'reference' && referenceRigAvailable ? referenceNodes : analysisNodes
)

export const applyAnalysisChassisPose = (
  rig: Pick<CarRig, 'chassis' | 'suspensionLinks'>,
  pose: CarPose,
) => {
  rig.chassis.position.y = pose.positionY
  rig.chassis.rotation.z = pose.rotationZ
  rig.chassis.updateMatrix()
  rig.suspensionLinks.forEach((link) => {
    link.chassisEnd.copy(link.chassisAnchor).applyMatrix4(rig.chassis.matrix)
    poseRod(link.mesh, link.fixedAnchor, link.chassisEnd)
  })
}

export const buildCar = (): CarRig => {
  const root = new THREE.Group()
  root.name = 'parameterized-modern-f1-car'
  const body = new THREE.MeshStandardMaterial({ color: 0xff6b2c, metalness: 0.62, roughness: 0.2 })
  const bodySecondary = body.clone()
  const carbon = new THREE.MeshStandardMaterial({ color: 0x080c0e, metalness: 0.72, roughness: 0.3 })
  const carbonSatin = new THREE.MeshStandardMaterial({ color: 0x172126, metalness: 0.55, roughness: 0.42 })
  const tyre = new THREE.MeshStandardMaterial({ color: 0x050607, metalness: 0.02, roughness: 0.94 })
  const wheelCover = new THREE.MeshStandardMaterial({ color: 0x1d272b, metalness: 0.78, roughness: 0.2 })
  const visor = new THREE.MeshPhysicalMaterial({
    color: 0x12343f, metalness: 0.22, roughness: 0.08, transmission: 0.32, transparent: true, opacity: 0.86,
  })

  const floorThroat = new THREE.Group()
  floorThroat.name = 'floor-throat'
  floorThroat.add(roundedBox(
    [analysisFloorGeometry.length, analysisFloorGeometry.thickness, 1.84],
    carbon,
    [analysisFloorGeometry.centerX, analysisFloorGeometry.centerY, 0],
    0.035,
  ))
  root.add(floorThroat)
  const floorEdgeLeft = new THREE.Group()
  floorEdgeLeft.name = 'floor-edge-left'
  floorEdgeLeft.position.set(0.42, 0.3, 0.95)
  const floorEdgeRight = new THREE.Group()
  floorEdgeRight.name = 'floor-edge-right'
  floorEdgeRight.position.set(0.42, 0.3, -0.95)
  for (const side of [-1, 1]) {
    const floorEdge = side > 0 ? floorEdgeLeft : floorEdgeRight
    floorEdge.add(roundedBox([4.0, 0.095, 0.075], carbonSatin, [0, 0, 0], 0.02))
    floorEdge.add(roundedBox([0.48, 0.2, 0.045], carbon, [-1.44, 0.07, 0], 0.012))
    floorEdge.add(roundedBox([0.38, 0.16, 0.045], carbon, [-0.9, 0.06, 0], 0.012))
  }
  root.add(floorEdgeLeft, floorEdgeRight)

  const monocoque = new THREE.Mesh(new THREE.CapsuleGeometry(0.47, 3.15, 12, 24), body)
  monocoque.rotation.z = Math.PI / 2
  monocoque.scale.z = 0.72
  monocoque.position.set(-0.62, 0.73, 0)
  monocoque.castShadow = true
  root.add(monocoque)
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.32, 2.4, 20), bodySecondary)
  nose.rotation.z = Math.PI / 2
  nose.scale.z = 0.72
  nose.position.set(-2.54, 0.56, 0)
  nose.castShadow = true
  root.add(nose)
  root.add(ellipsoid([0.72, 0.34, 0.46], bodySecondary, [-0.95, 0.92, 0]))

  for (const side of [-1, 1]) {
    const pod = roundedBox([1.92, 0.52, 0.58], bodySecondary, [0.48, 0.71, side * 0.64], 0.2)
    pod.rotation.y = side * THREE.MathUtils.degToRad(3)
    pod.rotation.z = THREE.MathUtils.degToRad(-3)
    root.add(pod)
    const inlet = ellipsoid([0.16, 0.19, 0.29], carbon, [-0.48, 0.86, side * 0.77], 20)
    inlet.scale.x = 0.42
    root.add(inlet)
    root.add(ellipsoid([1.02, 0.16, 0.28], carbon, [0.45, 0.42, side * 0.74], 20))
    root.add(roundedBox([0.72, 0.065, 0.12], bodySecondary, [-0.92, 0.51, side * 0.92], 0.025))
  }

  root.add(ellipsoid([1.55, 0.46, 0.43], bodySecondary, [1.25, 0.91, 0]))
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.5, 20), bodySecondary)
  tail.rotation.z = -Math.PI / 2
  tail.scale.z = 0.72
  tail.position.set(2.15, 0.77, 0)
  tail.castShadow = true
  root.add(tail)
  root.add(ellipsoid([0.72, 0.34, 0.42], visor, [-0.45, 1.19, 0]))
  root.add(ellipsoid([0.25, 0.29, 0.25], bodySecondary, [-0.24, 1.43, 0], 24))
  const airbox = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 0.5, 16), carbon)
  airbox.position.set(0.43, 1.48, 0)
  airbox.castShadow = true
  root.add(airbox)
  root.add(verticalPlate([[0.4, 1.16], [0.93, 1.72], [1.78, 1.02], [1.95, 0.84]], 0.075, carbon))

  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.045, 8, 36, Math.PI * 1.7), carbon)
  halo.rotation.set(Math.PI / 2, 0, -0.31)
  halo.position.set(-0.44, 1.44, 0)
  root.add(halo)
  root.add(rod(new THREE.Vector3(-0.78, 1.13, 0), new THREE.Vector3(-0.82, 1.5, 0), 0.038, carbon))
  root.add(rod(new THREE.Vector3(-0.05, 1.18, 0.31), new THREE.Vector3(0.11, 1.5, 0.18), 0.032, carbon))
  root.add(rod(new THREE.Vector3(-0.05, 1.18, -0.31), new THREE.Vector3(0.11, 1.5, -0.18), 0.032, carbon))

  const frontWingMainplane = new THREE.Group()
  frontWingMainplane.name = 'front-wing-mainplane'
  frontWingMainplane.position.set(-3.48, 0.3, 0)
  wingBlade(frontWingMainplane, [0, 0, 0], [0.34, 0.055, 3.35], 1, body)
  const frontWingFlap = new THREE.Group()
  frontWingFlap.name = 'front-wing-flap'
  frontWingFlap.position.set(-3.48, 0.3, 0)
  wingBlade(frontWingFlap, [0.19, 0.08, 0], [0.3, 0.05, 3.06], -3, carbonSatin)
  wingBlade(frontWingFlap, [0.37, 0.16, 0], [0.25, 0.048, 2.78], -7, bodySecondary)
  wingBlade(frontWingFlap, [0.53, 0.23, 0], [0.2, 0.045, 2.42], -10, carbon)
  const frontWingStructure = new THREE.Group()
  frontWingStructure.name = 'front-wing-structure'
  frontWingStructure.position.set(-3.48, 0.3, 0)
  for (const side of [-1, 1]) {
    const plate = verticalPlate([[-0.12, -0.06], [0.46, -0.01], [0.58, 0.46], [0.1, 0.4]], 0.065, bodySecondary)
    plate.position.z = side * 1.66
    frontWingStructure.add(plate)
  }
  frontWingStructure.add(rod(new THREE.Vector3(0.42, 0.2, 0.24), new THREE.Vector3(0.82, 0.42, 0.24), 0.025, carbon))
  frontWingStructure.add(rod(new THREE.Vector3(0.42, 0.2, -0.24), new THREE.Vector3(0.82, 0.42, -0.24), 0.025, carbon))
  root.add(frontWingMainplane, frontWingFlap, frontWingStructure)

  const rearWingMainplane = new THREE.Group()
  rearWingMainplane.name = 'rear-wing-mainplane'
  rearWingMainplane.position.set(2.76, 1.42, 0)
  wingBlade(rearWingMainplane, [-0.17, 0, 0], [0.31, 0.065, 2.24], -10, carbonSatin)
  wingBlade(rearWingMainplane, [-0.3, -0.22, 0], [0.25, 0.055, 2.05], -14, bodySecondary)
  wingBlade(rearWingMainplane, [-0.17, -0.62, 0], [0.2, 0.05, 1.82], -8, carbon)
  const rearWingFlap = new THREE.Group()
  rearWingFlap.name = 'rear-wing-flap'
  rearWingFlap.position.set(2.76, 1.42, 0)
  wingBlade(rearWingFlap, [0, 0.23, 0], [0.34, 0.075, 2.36], -5, body)
  const rearWingStructure = new THREE.Group()
  rearWingStructure.name = 'rear-wing-structure'
  rearWingStructure.position.set(2.76, 1.42, 0)
  for (const side of [-1, 1]) {
    const plate = verticalPlate([[-0.2, -0.62], [0.18, -0.54], [0.2, 0.46], [-0.12, 0.5]], 0.07, carbon)
    plate.position.z = side * 1.17
    rearWingStructure.add(plate)
    rearWingStructure.add(rod(new THREE.Vector3(-0.16, -0.7, side * 0.52), new THREE.Vector3(-0.08, 0.08, side * 0.65), 0.035, carbon))
  }
  root.add(rearWingMainplane, rearWingFlap, rearWingStructure)

  const diffuser = new THREE.Group()
  diffuser.name = 'diffuser'
  diffuser.position.set(2.08, 0.28, 0)
  const ramp = roundedBox([1.3, 0.07, 1.5], carbon, [0, 0.12, 0], 0.018)
  ramp.rotation.z = THREE.MathUtils.degToRad(11)
  diffuser.add(ramp)
  for (const offset of [-0.62, -0.31, 0, 0.31, 0.62]) {
    const fence = roundedBox([0.82, 0.23, 0.025], carbon, [0.1, 0.16, offset], 0.008)
    fence.rotation.z = THREE.MathUtils.degToRad(11)
    diffuser.add(fence)
  }
  root.add(diffuser)

  const wheels: THREE.Group[] = []
  const unsprungNodes: THREE.Object3D[] = []
  const suspensionLinks: SuspensionLink[] = []
  for (const x of [analysisRideHeightDatum.frontX, analysisRideHeightDatum.rearX]) {
    for (const side of [-1, 1]) {
      const wheel = wheelAssembly(x, side, tyre, wheelCover, carbon)
      root.add(wheel)
      wheels.push(wheel)
      const arch = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.033, 8, 30, Math.PI), carbon)
      arch.position.set(x, 0.5, side * 1.08)
      root.add(arch)
      unsprungNodes.push(arch)
      const wheelAeroDetail = roundedBox([0.23, 0.22, 0.055], carbon, [x - 0.42, 0.78, side * 1.09], 0.018)
      root.add(wheelAeroDetail)
      unsprungNodes.push(wheelAeroDetail)
      const hub = new THREE.Vector3(x, 0.53, side * 0.88)
      const innerX = x + (x < 0 ? 0.42 : -0.4)
      const wheelLinks = [
        suspensionLink(hub, new THREE.Vector3(innerX, 0.94, side * 0.34), 0.023, carbon),
        suspensionLink(hub, new THREE.Vector3(innerX - 0.18, 0.48, side * 0.3), 0.02, carbon),
        suspensionLink(
          new THREE.Vector3(x, 0.62, side * 0.88),
          new THREE.Vector3(innerX, 1.08, side * 0.25),
          0.018,
          bodySecondary,
        ),
      ]
      suspensionLinks.push(...wheelLinks)
      wheelLinks.forEach(({ mesh }) => root.add(mesh))
    }
  }

  const componentNodes: ComponentNodes = {
    'front-wing-mainplane': frontWingMainplane,
    'front-wing-flap': frontWingFlap,
    'rear-wing-mainplane': rearWingMainplane,
    'rear-wing-flap': rearWingFlap,
    'floor-throat': floorThroat,
    'floor-edge-left': floorEdgeLeft,
    'floor-edge-right': floorEdgeRight,
    diffuser,
  }

  const chassis = new THREE.Group()
  chassis.name = 'analysis-chassis-pose'
  const fixedSet = new Set<THREE.Object3D>([
    ...wheels,
    ...unsprungNodes,
    ...suspensionLinks.map(({ mesh }) => mesh),
  ])
  ;[...root.children]
    .filter((child) => !fixedSet.has(child))
    .forEach((child) => chassis.add(child))
  root.add(chassis)

  return { root, chassis, componentNodes, accentMaterials: [body, bodySecondary], wheels, suspensionLinks }
}

const streamline = (
  layer: THREE.Group,
  lines: FlowLine[],
  points: THREE.Vector3[],
  color: number,
  opacity: number,
  speedFactor: number,
  radius = 0.012,
) => {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5)
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 120, radius, 5, false),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  tube.frustumCulled = false
  layer.add(tube)
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 3.6, radius * 11, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity + 0.35) }),
  )
  layer.add(arrow)
  lines.push({ curve, arrow, phase: (lines.length * 0.173) % 1, speedFactor })
}

const buildAirflow = (): AirflowRig => {
  const group = new THREE.Group()
  group.name = 'continuous-parametric-streamlines'
  const upperLayer = new THREE.Group()
  const floorLayer = new THREE.Group()
  const outwashLayer = new THREE.Group()
  const wakeLayer = new THREE.Group()
  group.add(upperLayer, floorLayer, outwashLayer, wakeLayer)
  const lines: FlowLine[] = []

  for (let index = 0; index < 7; index += 1) {
    const z = -2.7 + index * 0.9
    const y = 1.35 + Math.abs(index - 3) * 0.08
    streamline(upperLayer, lines, [
      new THREE.Vector3(-8, y, z), new THREE.Vector3(-4.2, y - 0.06, z),
      new THREE.Vector3(-3.35, 0.72 + index * 0.025, z * 0.93),
      new THREE.Vector3(-2, 0.92 + index * 0.03, z * 0.8),
      new THREE.Vector3(-0.62, 1.62 + index * 0.018, z * 0.69),
      new THREE.Vector3(0.72, 1.72 + index * 0.015, z * 0.78),
      new THREE.Vector3(2.1, 1.15 + index * 0.022, z * 0.98),
      new THREE.Vector3(3.25, 1.02 + index * 0.03, z * 1.1),
      new THREE.Vector3(5.6, 1.28 + index * 0.05, z * 1.32), new THREE.Vector3(8, 1.48 + index * 0.06, z * 1.52),
    ], 0x47d7ff, 0.34, 0.9 + index * 0.04)
  }
  for (let index = 0; index < 7; index += 1) {
    const z = -0.78 + index * 0.26
    streamline(floorLayer, lines, [
      new THREE.Vector3(-8, 0.42, z), new THREE.Vector3(-4.2, 0.38, z),
      new THREE.Vector3(-3.2, 0.29, z * 0.98), new THREE.Vector3(-1.65, 0.22, z * 0.92),
      new THREE.Vector3(0.15, 0.19, z * 0.88), new THREE.Vector3(1.62, 0.24, z * 0.92),
      new THREE.Vector3(2.72, 0.43, z * 1.05), new THREE.Vector3(4.1, 0.67, z * 1.22),
      new THREE.Vector3(6.4, 0.82, z * 1.42), new THREE.Vector3(8, 0.9, z * 1.58),
    ], 0xc8f04a, 0.58, 1.25 + index * 0.04, 0.014)
  }
  for (const side of [-1, 1]) {
    for (let index = 0; index < 4; index += 1) {
      const z = side * (0.92 + index * 0.26)
      streamline(outwashLayer, lines, [
        new THREE.Vector3(-7.5, 0.62 + index * 0.15, z), new THREE.Vector3(-4, 0.6 + index * 0.14, z),
        new THREE.Vector3(-2.55, 0.65 + index * 0.12, z * 1.28),
        new THREE.Vector3(-1.65, 0.72 + index * 0.12, z * 1.48),
        new THREE.Vector3(-0.2, 0.82 + index * 0.14, z * 1.56),
        new THREE.Vector3(1.72, 0.76 + index * 0.17, z * 1.7),
        new THREE.Vector3(3.3, 0.9 + index * 0.18, z * 1.84),
        new THREE.Vector3(5.6, 1.1 + index * 0.2, z * 2.02), new THREE.Vector3(8, 1.3 + index * 0.23, z * 2.18),
      ], 0x47d7ff, 0.31, 0.82 + index * 0.06)
    }
  }
  for (let index = 0; index < 7; index += 1) {
    const z = -1.35 + index * 0.45
    streamline(wakeLayer, lines, [
      new THREE.Vector3(2.05, 0.62 + index * 0.15, z), new THREE.Vector3(2.9, 0.78 + index * 0.16, z * 1.05),
      new THREE.Vector3(3.7, 1.02 + index * 0.17, z * 1.18),
      new THREE.Vector3(4.8, 1.15 + index * 0.21, z * 1.35),
      new THREE.Vector3(6.25, 1.18 + index * 0.24, z * 1.58), new THREE.Vector3(8, 1.05 + index * 0.27, z * 1.9),
    ], 0xff6b2c, 0.46, 1.15 + index * 0.05, 0.014)
  }
  return { group, lines, floorLayer, upperLayer, wakeLayer }
}

export const WindTunnelView = ({ car, params, result, onReferenceCapabilityChange }: WindTunnelViewProps) => {
  const mountRef = useRef<HTMLDivElement>(null)
  const latestRef = useRef({ car, params, result })
  const modelModeRef = useRef<ModelMode>('analysis')
  const setCameraViewRef = useRef<(view: CameraView) => void>(() => undefined)
  const setModelModeRef = useRef<(mode: ModelMode) => void>(() => undefined)
  const loadCarRef = useRef<(carId: string, ruleset: SimulationParams['ruleset']) => void>(() => undefined)
  const [cameraView, setCameraView] = useState<CameraView>('orbit')
  const [modelMode, setModelMode] = useState<ModelMode>('analysis')
  const [webglError, setWebglError] = useState(false)
  const [referenceLoadState, setReferenceLoadState] = useState<'loading' | 'loaded' | 'fallback'>('loading')
  const [referenceRigStatus, setReferenceRigStatus] = useState<SemanticRigStatus>('static')
  const [modelCredit, setModelCredit] = useState<CarModelCredit>(carModelCredits[car.id])
  const [windLayerCount, setWindLayerCount] = useState(0)
  const [windTracerCount, setWindTracerCount] = useState(0)
  const [windDeltaMm, setWindDeltaMm] = useState(0)
  const [windDeltaLabel, setWindDeltaLabel] = useState('等待翼面调整')
  const [loadDrivenWake, setLoadDrivenWake] = useState(false)
  const loadDrivenWakeRef = useRef(false)
  loadDrivenWakeRef.current = loadDrivenWake
  latestRef.current = { car, params, result }
  const lowDragState = result.ruleset === '2026' ? result.activeAeroMode === 'straight' : result.drsActive
  const fieldLabel = lowDragState ? '低阻气流场' : '高下压力气流场'
  const referenceIsAdjustable = referenceLoadState === 'loaded' && referenceRigStatus === 'available'

  useEffect(() => {
    onReferenceCapabilityChange?.({
      referenceMode: modelMode === 'reference',
      wingAdjustable: referenceIsAdjustable,
    })
  }, [modelMode, onReferenceCapabilityChange, referenceIsAdjustable])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return undefined
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      setWebglError(true)
      setReferenceLoadState('fallback')
      setReferenceRigStatus('static')
      return undefined
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.22
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute('aria-label', '交互式三维现代 F1 赛车风洞模型')
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x071013, 0.035)
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 80)
    camera.position.set(6.25, 3.25, 6.85)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.78, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.065
    controls.enablePan = false
    controls.minDistance = 6
    controls.maxDistance = 16
    controls.maxPolarAngle = Math.PI * 0.49
    const markOrbit = () => setCameraView('orbit')
    controls.addEventListener('start', markOrbit)

    scene.add(new THREE.HemisphereLight(0xc8efff, 0x05090b, 1.5))
    const key = new THREE.DirectionalLight(0xfff7e7, 4.8)
    key.position.set(-5, 9, 6)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    scene.add(key)
    const cyanLight = new THREE.PointLight(0x47d7ff, 17, 15)
    cyanLight.position.set(-4, 2.5, 4)
    scene.add(cyanLight)
    const orangeLight = new THREE.PointLight(0xff6b2c, 15, 14)
    orangeLight.position.set(4, 1.6, -3.5)
    scene.add(orangeLight)

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 16), new THREE.MeshStandardMaterial({ color: 0x071012, metalness: 0.7, roughness: 0.38 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)
    const grid = new THREE.GridHelper(30, 60, 0x4b8a92, 0x183239)
    grid.position.y = 0.012
    scene.add(grid)
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(16, 5.4, 8.2)),
      new THREE.LineBasicMaterial({ color: 0x37666c, transparent: true, opacity: 0.28 }),
    )
    frame.position.y = 2.7
    scene.add(frame)

    const carSystem = new THREE.Group()
    carSystem.name = 'car-pose-system'
    scene.add(carSystem)
    const rig = buildCar()
    carSystem.add(rig.root)
    const airflow = buildAirflow()
    scene.add(airflow.group)
    let highDetailRoot: THREE.Group | null = null
    let highDetailMeshes: THREE.Mesh[] = []
    let highDetailComponentNodes: SemanticComponentNodes = {}
    let highDetailComponentRigAvailable = false
    let highDetailWheelNodes: SemanticWheelNodes = {}
    let highDetailWheelRigAvailable = false
    let highDetailWheelRestZ = new Map<THREE.Object3D, number>()
    let surfaceFlowBounds: THREE.Box3 | null = null
    let surfaceFlow: SurfaceFlowRig | null = null
    let surfaceFlowOpacity = 1
    let surfaceFlowTransitionStartedAt = 0
    let retiringSurfaceFlow: {
      rig: SurfaceFlowRig
      startOpacity: number
      holdUntil: number
      fadeSeconds: number
      /** Set while the rig is the muted pre-adjustment reference that later rebuilds compare against. */
      baseline?: { snapshot: SurfaceFlowSnapshot; params: SimulationParams; result: AeroResult }
    } | null = null
    let componentOverlay: {
      overlay: ComponentChangeOverlay
      holdUntil: number
      fadeSeconds: number
    } | null = null
    let lastBuiltFlowShapeKey = ''
    let lastBuiltFlowParams: SimulationParams | null = null
    let lastBuiltFlowResult: AeroResult | null = null
    let pendingFlowShapeKey = ''
    let flowRebuildDueAt = 0
    let loadToken = 0
    let disposed = false
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const disposeSurfaceFlow = (flow: SurfaceFlowRig) => {
      scene.remove(flow.group)
      flow.dispose()
    }

    const resolveWakeUpwash = () => (
      loadDrivenWakeRef.current
        ? resolveLoadDrivenWakeUpwash(rearWingLoadRatio(latestRef.current.car, latestRef.current.params))
        : undefined
    )
    const flowShapeKey = () => {
      const wake = resolveWakeUpwash()
      return `reference:${latestRef.current.car.id}:${resolveReferenceFlowKey(latestRef.current.params)}`
        + `:wake:${wake === undefined ? 'geometric' : wake.toFixed(3)}`
    }
    const disposeComponentOverlay = () => {
      componentOverlay?.overlay.dispose()
      componentOverlay = null
    }

    const syncModelVisibility = () => {
      const visibility = resolveModelVisibility(modelModeRef.current, highDetailRoot !== null)
      rig.root.visible = visibility.analysis
      airflow.group.visible = visibility.analysis
      if (highDetailRoot) highDetailRoot.visible = visibility.reference
      if (surfaceFlow) surfaceFlow.group.visible = visibility.reference
      if (retiringSurfaceFlow) retiringSurfaceFlow.rig.group.visible = visibility.reference
    }

    const rebuildSurfaceFlow = () => {
      if (!highDetailRoot || highDetailMeshes.length === 0) return
      const previousFlow = surfaceFlow
      const previousOpacity = surfaceFlowOpacity
      const current = latestRef.current
      const startedAt = performance.now() / 1000
      // While a muted baseline is still on screen, keep comparing against it so a
      // slider drag reads as one cumulative change instead of many tiny steps.
      const anchor = retiringSurfaceFlow?.baseline && startedAt < retiringSurfaceFlow.holdUntil
        ? retiringSurfaceFlow
        : null
      const comparison = anchor?.baseline
        ?? (previousFlow && lastBuiltFlowParams && lastBuiltFlowResult
          ? { snapshot: captureSurfaceFlowSnapshot(previousFlow), params: lastBuiltFlowParams, result: lastBuiltFlowResult }
          : null)
      const focus = comparison ? resolveFlowChangeFocus(comparison.params, current.params) : null
      if (retiringSurfaceFlow && !anchor) {
        disposeSurfaceFlow(retiringSurfaceFlow.rig)
        retiringSurfaceFlow = null
      }
      disposeComponentOverlay()
      const currentPose = resolveComponentPose(current.params, current.result)
      if (highDetailComponentRigAvailable) applyComponentPose(highDetailComponentNodes, currentPose)
      carSystem.updateMatrixWorld(true)
      // Sample with the wheels at rest: spinning tread would otherwise add
      // millimetres of noise that reads as a wing-induced path change.
      const spinningWheelZ = [...highDetailWheelRestZ.keys()].map((wheel) => wheel.rotation.z)
      highDetailWheelRestZ.forEach((restZ, wheel) => { wheel.rotation.z = restZ })
      carSystem.updateMatrixWorld(true)
      if (!surfaceFlowBounds) surfaceFlowBounds = new THREE.Box3().setFromObject(highDetailRoot)
      const nextFlow = buildSurfaceFlow(
        highDetailMeshes,
        surfaceFlowBounds,
        window.innerWidth <= 760,
        { wakeUpwashM: resolveWakeUpwash() },
      )
      ;[...highDetailWheelRestZ.keys()].forEach((wheel, index) => { wheel.rotation.z = spinningWheelZ[index] })
      const delta = comparison && focus
        ? applySurfaceFlowDelta(nextFlow, comparison.snapshot, focus, 3)
        : null
      surfaceFlow = nextFlow
      surfaceFlowOpacity = reducedMotion || anchor ? 1 : 0
      surfaceFlowTransitionStartedAt = startedAt
      setSurfaceFlowOpacity(nextFlow, surfaceFlowOpacity)
      scene.add(nextFlow.group)
      const holdUntil = startedAt + SURFACE_FLOW_BASELINE_HOLD_SECONDS
      const baselineFadeSeconds = reducedMotion ? 0 : SURFACE_FLOW_BASELINE_FADE_SECONDS
      if (anchor) {
        // The intermediate field is replaced outright; the original baseline stays.
        if (previousFlow) disposeSurfaceFlow(previousFlow)
        if (focus) anchor.holdUntil = holdUntil
        else {
          disposeSurfaceFlow(anchor.rig)
          retiringSurfaceFlow = null
        }
      } else if (previousFlow) {
        // Any real wing change starts a comparison, even when the first slider
        // step is too small to move a sample, so a drag accumulates against it.
        if (focus && comparison) {
          setSurfaceFlowBaselineStyle(previousFlow)
          const baselineOpacity = 0.34
          setSurfaceFlowOpacity(previousFlow, baselineOpacity)
          retiringSurfaceFlow = {
            rig: previousFlow,
            startOpacity: baselineOpacity,
            holdUntil,
            fadeSeconds: baselineFadeSeconds,
            baseline: comparison,
          }
        } else if (reducedMotion) disposeSurfaceFlow(previousFlow)
        else retiringSurfaceFlow = {
          rig: previousFlow,
          startOpacity: previousOpacity,
          holdUntil: startedAt,
          fadeSeconds: SURFACE_FLOW_TRANSITION_SECONDS,
        }
      }
      if (focus && comparison && highDetailComponentRigAvailable) {
        const overlay = createComponentChangeOverlay(
          highDetailComponentNodes,
          resolveComponentPose(comparison.params, comparison.result),
          currentPose,
        )
        if (overlay) componentOverlay = { overlay, holdUntil, fadeSeconds: baselineFadeSeconds }
      }
      lastBuiltFlowShapeKey = flowShapeKey()
      lastBuiltFlowParams = current.params
      lastBuiltFlowResult = current.result
      pendingFlowShapeKey = ''
      flowRebuildDueAt = 0
      setWindLayerCount(nextFlow.layerCount)
      setWindTracerCount(nextFlow.tracers.length)
      setWindDeltaMm(delta?.maxOffsetM ? delta.maxOffsetM * 1000 : 0)
      setWindDeltaLabel(delta && focus && delta.affectedSamples > 0
        ? flowFocusLabels[focus]
        : focus ? `${flowFocusLabels[focus]} · 采样无可见偏移` : '等待翼面调整')
      syncModelVisibility()
    }

    setModelModeRef.current = (mode) => {
      modelModeRef.current = mode
      if (mode === 'reference' && highDetailRoot) {
        const nextFlowShapeKey = flowShapeKey()
        if (
          !surfaceFlow
          || (highDetailComponentRigAvailable && lastBuiltFlowShapeKey !== nextFlowShapeKey)
        ) rebuildSurfaceFlow()
      } else {
        flowRebuildDueAt = 0
        pendingFlowShapeKey = ''
      }
      syncModelVisibility()
    }

    const clearHighDetailModel = () => {
      disposeComponentOverlay()
      if (surfaceFlow) {
        disposeSurfaceFlow(surfaceFlow)
        surfaceFlow = null
      }
      if (retiringSurfaceFlow) {
        disposeSurfaceFlow(retiringSurfaceFlow.rig)
        retiringSurfaceFlow = null
      }
      surfaceFlowOpacity = 1
      surfaceFlowTransitionStartedAt = 0
      if (highDetailRoot) {
        carSystem.remove(highDetailRoot)
        disposeObject3D(highDetailRoot)
        highDetailRoot = null
      }
      highDetailMeshes = []
      highDetailComponentNodes = {}
      highDetailComponentRigAvailable = false
      highDetailWheelNodes = {}
      highDetailWheelRigAvailable = false
      highDetailWheelRestZ = new Map()
      surfaceFlowBounds = null
      lastBuiltFlowShapeKey = ''
      lastBuiltFlowParams = null
      lastBuiltFlowResult = null
      pendingFlowShapeKey = ''
      flowRebuildDueAt = 0
      syncModelVisibility()
    }

    loadCarRef.current = (carId, ruleset) => {
      const token = ++loadToken
      modelModeRef.current = 'analysis'
      setModelMode('analysis')
      clearHighDetailModel()
      syncModelVisibility()
      setReferenceLoadState('loading')
      setReferenceRigStatus('static')
      setWindLayerCount(0)
      setWindTracerCount(0)
      setWindDeltaMm(0)
      setWindDeltaLabel('等待翼面调整')

      void loadHighDetailCar(carId, ruleset).then((loaded) => {
        if (disposed || token !== loadToken) {
          disposeObject3D(loaded.root)
          return
        }
        highDetailRoot = loaded.root
        highDetailMeshes = loaded.meshes
        highDetailComponentNodes = loaded.componentNodes
        highDetailComponentRigAvailable = loaded.componentRigAvailable
        highDetailWheelNodes = loaded.wheelNodes
        highDetailWheelRigAvailable = loaded.wheelRigAvailable
        highDetailWheelRestZ = new Map(Object.values(loaded.wheelNodes).map((wheel) => [wheel, wheel.rotation.z]))
        highDetailRoot.visible = true
        carSystem.add(highDetailRoot)
        carSystem.updateMatrixWorld(true)
        modelModeRef.current = 'reference'
        setModelMode('reference')
        setModelCredit(loaded.credit)
        setReferenceLoadState('loaded')
        setReferenceRigStatus(loaded.componentRigStatus)
        rebuildSurfaceFlow()
        syncModelVisibility()
      }).catch(() => {
        if (disposed || token !== loadToken) return
        clearHighDetailModel()
        modelModeRef.current = 'analysis'
        setModelMode('analysis')
        syncModelVisibility()
        setReferenceLoadState('fallback')
        setReferenceRigStatus('static')
      })
    }

    setCameraViewRef.current = (view) => {
      if (view === 'side') camera.position.set(0, 2.15, 11.25)
      else if (view === 'front') camera.position.set(-8.45, 2.1, 0.12)
      else camera.position.set(6.25, 3.25, 6.85)
      controls.target.set(0, 0.78, 0)
      controls.update()
    }
    const resize = () => {
      const width = Math.max(1, mount.clientWidth)
      const height = Math.max(1, mount.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(mount)
    resize()

    const clock = new THREE.Clock()
    const up = new THREE.Vector3(0, 1, 0)
    let previousElapsed = 0
    let frameId = 0
    const animate = () => {
      frameId = requestAnimationFrame(animate)
      const elapsed = clock.getElapsedTime()
      const delta = Math.min(0.05, elapsed - previousElapsed)
      previousElapsed = elapsed
      const current = latestRef.current
      const speed = current.params.run.speedKph
      const carPose = resolveCarPose(current.params)
      const componentPose = resolveComponentPose(current.params, current.result)

      applyAnalysisChassisPose(rig, carPose)
      const activeComponentNodes = resolveActiveComponentNodes(
        modelModeRef.current,
        rig.componentNodes,
        highDetailComponentNodes,
        highDetailComponentRigAvailable,
      )
      applyComponentPose(activeComponentNodes, componentPose)
      rig.accentMaterials.forEach((material) => material.color.set(current.car.accent))
      if (!reducedMotion) {
        const wheelDelta = ((speed / 3.6) / 0.49) * delta * 0.18
        rig.wheels.forEach((wheel) => { wheel.rotation.z -= wheelDelta })
        if (modelModeRef.current === 'reference' && highDetailWheelRigAvailable) {
          rotateSemanticWheels(highDetailWheelNodes, -wheelDelta)
        }
      }
      const flowRate = reducedMotion ? 0 : 0.018 + speed / 4400
      airflow.lines.forEach(({ curve, arrow, phase, speedFactor }) => {
        const progress = (phase + elapsed * flowRate * speedFactor) % 1
        const position = curve.getPointAt(progress)
        const tangent = curve.getTangentAt(progress).normalize()
        arrow.position.copy(position)
        arrow.quaternion.setFromUnitVectors(up, tangent)
      })
      airflow.floorLayer.scale.y = THREE.MathUtils.clamp(0.92 + current.result.groundEffectFactor * 0.05, 0.92, 1.08)
      airflow.wakeLayer.rotation.z = THREE.MathUtils.degToRad((current.params.garage.rearWingLoadPercent - 50) * 0.025)
      airflow.wakeLayer.scale.z = THREE.MathUtils.clamp(0.96 + current.result.effectiveCd * 0.16, 0.96, 1.12)
      const currentFlowShapeKey = flowShapeKey()
      if (modelModeRef.current === 'reference' && highDetailRoot && highDetailComponentRigAvailable) {
        if (currentFlowShapeKey === lastBuiltFlowShapeKey) {
          pendingFlowShapeKey = ''
          flowRebuildDueAt = 0
        } else if (currentFlowShapeKey !== pendingFlowShapeKey) {
          pendingFlowShapeKey = currentFlowShapeKey
          flowRebuildDueAt = elapsed + 0.14
        }
      }
      if (modelModeRef.current === 'reference' && flowRebuildDueAt > 0 && elapsed >= flowRebuildDueAt) {
        flowRebuildDueAt = 0
        rebuildSurfaceFlow()
      }
      const transitionNow = performance.now() / 1000
      if (surfaceFlow) {
        if (!reducedMotion) {
          surfaceFlowOpacity = THREE.MathUtils.smoothstep(
            transitionNow - surfaceFlowTransitionStartedAt,
            0,
            SURFACE_FLOW_TRANSITION_SECONDS,
          )
          setSurfaceFlowOpacity(surfaceFlow, surfaceFlowOpacity)
        }
        updateSurfaceFlow(surfaceFlow, elapsed, speed, reducedMotion)
      }
      if (retiringSurfaceFlow) {
        const transitionProgress = retiringSurfaceFlow.fadeSeconds === 0
          ? (transitionNow >= retiringSurfaceFlow.holdUntil ? 1 : 0)
          : THREE.MathUtils.smoothstep(
            transitionNow - retiringSurfaceFlow.holdUntil,
            0,
            retiringSurfaceFlow.fadeSeconds,
          )
        setSurfaceFlowOpacity(
          retiringSurfaceFlow.rig,
          retiringSurfaceFlow.startOpacity * (1 - transitionProgress),
        )
        updateSurfaceFlow(retiringSurfaceFlow.rig, elapsed, speed, reducedMotion)
        if (transitionProgress >= 1) {
          disposeSurfaceFlow(retiringSurfaceFlow.rig)
          retiringSurfaceFlow = null
        }
      }
      if (componentOverlay) {
        const overlayProgress = componentOverlay.fadeSeconds === 0
          ? (transitionNow >= componentOverlay.holdUntil ? 1 : 0)
          : THREE.MathUtils.smoothstep(transitionNow - componentOverlay.holdUntil, 0, componentOverlay.fadeSeconds)
        const glow = reducedMotion ? 1 : 0.72 + Math.sin(elapsed * 5.2) * 0.28
        componentOverlay.overlay.setOpacity((1 - overlayProgress) * glow)
        if (overlayProgress >= 1 || modelModeRef.current !== 'reference') disposeComponentOverlay()
      }
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      disposed = true
      loadToken += 1
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      controls.removeEventListener('start', markOrbit)
      controls.dispose()
      clearHighDetailModel()
      loadCarRef.current = () => undefined
      setModelModeRef.current = () => undefined
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach((material) => material.dispose())
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  useEffect(() => {
    setModelCredit(carModelCredits[car.id])
    loadCarRef.current(car.id, params.ruleset)
  }, [car.id, params.ruleset])

  const chooseView = (view: CameraView) => {
    setCameraView(view)
    setCameraViewRef.current(view)
  }

  const chooseModelMode = (mode: ModelMode) => {
    if (mode === 'reference' && referenceLoadState !== 'loaded') return
    setModelMode(mode)
    setModelModeRef.current(mode)
  }

  return (
    <section className="tunnel-card tunnel-card--3d" aria-labelledby="tunnel-title">
      <div className="tunnel-card__header">
        <div>
          <div className="eyebrow"><span className="live-dot" /> {modelMode === 'analysis'
            ? '参数化分析模型'
            : referenceIsAdjustable ? '授权参考模型 · 前后翼可调' : '授权参考模型 · 静态'}</div>
          <h2 id="tunnel-title">{fieldLabel}</h2>
        </div>
        <div className="tunnel-card__readout">
          <span>{result.activeAeroLabel}</span>
          <strong>{Math.round(params.run.speedKph).toString().padStart(3, '0')} <small>KM/H</small></strong>
        </div>
      </div>
      <div className="tunnel-stage tunnel-stage--3d">
        <div className="stage-label stage-label--inlet">来流入口 <span>→</span></div>
        <div className="stage-label stage-label--floor">文丘里底板 / 地面</div>
        <div className="tunnel-model-toolbar" aria-label="模型模式">
          {(['analysis', 'reference'] as ModelMode[]).map((mode) => (
            <button
              type="button"
              key={mode}
              className={modelMode === mode ? 'is-active' : ''}
              aria-pressed={modelMode === mode}
              disabled={mode === 'reference' && referenceLoadState !== 'loaded'}
              title={mode === 'reference' && referenceLoadState !== 'loaded'
                ? (referenceLoadState === 'fallback' ? '参考模型不可用' : '参考模型加载中')
                : mode === 'reference' && !referenceIsAdjustable
                  ? '参考模型为静态几何；请使用分析模型调整部件'
                  : undefined}
              onClick={() => chooseModelMode(mode)}
            >
              {modelModeLabels[mode]}
            </button>
          ))}
          {modelMode === 'reference' && referenceIsAdjustable && (
            <button
              type="button"
              className={loadDrivenWake ? 'is-active' : ''}
              aria-pressed={loadDrivenWake}
              title="按后部下压力趋势缩放尾翼后的上洗高度（显示放大 ×3，非 CFD）"
              onClick={() => setLoadDrivenWake((value) => !value)}
            >
              载荷尾流
            </button>
          )}
        </div>
        <div className="tunnel-3d-toolbar" aria-label="三维相机视角">
          {(['orbit', 'side', 'front'] as CameraView[]).map((view) => (
            <button type="button" key={view} className={cameraView === view ? 'is-active' : ''} aria-pressed={cameraView === view} onClick={() => chooseView(view)}>
              {cameraViewLabels[view]}
            </button>
          ))}
        </div>
        {webglError ? <div className="tunnel-3d-error" role="alert">WebGL 初始化失败</div> : <div ref={mountRef} className="tunnel-3d-canvas" />}
        <div className="tunnel-3d-hud" aria-live="polite">
          <span>底板载荷 <b>{result.floorLoadFactor.toFixed(2)}×</b></span>
          <span>前/后离地高度 <b>{params.garage.frontRideHeightMm}/{params.garage.rearRideHeightMm} mm</b></span>
          <span>阻力 <b>{Math.round(result.totalDragN).toLocaleString('zh-CN')} N</b></span>
          {modelMode === 'reference' && referenceIsAdjustable
            ? <span className={windDeltaMm > 0 ? 'is-delta' : ''}>{loadDrivenWake ? '路径偏移·含趋势' : '采样路径偏移'} <b>{windDeltaMm > 0 ? `${windDeltaMm.toFixed(1)} mm` : '—'}</b></span>
            : modelMode === 'reference'
              ? <span>参考风场 <b>静态</b></span>
            : <span>部件响应 <b>分析趋势</b></span>}
        </div>
      </div>
      <div className="tunnel-card__footer">
        <div className="legend"><span className="legend-line legend-line--cyan" /> 上部气流</div>
        <div className="legend"><span className="legend-line legend-line--lime" /> 底板高速气流</div>
        <div className="legend"><span className="legend-line legend-line--orange" /> 尾流</div>
        {modelMode === 'reference' && referenceIsAdjustable && (
          <div className="legend"><span className="legend-line legend-line--delta" /> 调整影响 / {windDeltaLabel}</div>
        )}
        <div className="tunnel-card__footer-note">
          {modelMode === 'reference'
            ? referenceIsAdjustable
              ? `${windLayerCount} 层烟流 + ${windTracerCount} 条示踪路径 · 授权参考模型 · 前后翼可调`
              : '授权参考模型 · 静态几何 · 部件调整请使用分析模型'
            : '参数化分析模型 · 独立空气动力表面'}
          {modelMode === 'reference' && referenceIsAdjustable
            ? `${loadDrivenWake ? ' · 尾流按后部载荷趋势缩放' : ''} · 差值趋势 · 显示放大×3 · 非 CFD`
            : modelMode === 'reference'
              ? ' · 静态参考风场 · 非 CFD'
            : ' · 趋势视图 · 非 CFD'}
        </div>
        <div className="model-credit">
          {modelMode === 'reference' ? (
            <>
              模型 <a href={modelCredit.sourceUrl} target="_blank" rel="noreferrer">{modelCredit.name}</a>
              {' '}作者 <a href={modelCredit.authorUrl} target="_blank" rel="noreferrer">{modelCredit.author}</a>
              {' '}· <a href={modelCredit.licenseUrl} target="_blank" rel="noreferrer">CC BY 4.0</a>
              {' '}· 网页优化衍生版本
            </>
          ) : '分析几何 · 前后翼、底板边缘与扩散器均为独立节点'}
        </div>
      </div>
    </section>
  )
}
