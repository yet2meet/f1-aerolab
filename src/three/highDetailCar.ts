import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { AdjustableComponentId, SemanticComponentNodes } from './componentRig'
import type { Ruleset } from '../types'

export type CarModelOrientation = 'source' | 'web'
export type SemanticRigStatus = 'available' | 'static'
export const semanticWheelIds = [
  'wheel-front-left',
  'wheel-front-right',
  'wheel-rear-left',
  'wheel-rear-right',
] as const
export type SemanticWheelId = typeof semanticWheelIds[number]
export type SemanticWheelNodes = Partial<Record<SemanticWheelId, THREE.Object3D>>

export type CarModelCredit = {
  file: string
  orientation: CarModelOrientation
  ruleset: Ruleset
  name: string
  author: string
  authorUrl: string
  sourceUrl: string
  licenseUrl: string
}

export const carModelCredits: Record<string, CarModelCredit> = {
  'apex-r26': {
    file: 'rb22-wheels-rigged.glb',
    orientation: 'web',
    ruleset: '2026',
    name: '2026 Red Bull Racing RB22',
    author: 'Dave Love SketchFab',
    authorUrl: 'https://sketchfab.com/Tyler_Dave',
    sourceUrl: 'https://sketchfab.com/3d-models/2026-red-bull-racing-rb22-8e5a68a7991c4a46bd66a879c060b3c5',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  'vortex-vx': {
    file: 'haas-vf26.glb',
    orientation: 'source',
    ruleset: '2026',
    name: '2026 Haas VF-26',
    author: 'Dave Love SketchFab',
    authorUrl: 'https://sketchfab.com/Tyler_Dave',
    sourceUrl: 'https://sketchfab.com/3d-models/2026-haas-vf-26-1f41e03886724bc6acd16c92402989bc',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  'mistral-mk': {
    file: 'sf23.glb',
    orientation: 'source',
    ruleset: '2022-2025',
    name: 'Scuderia Ferrari F1 SF23 2023',
    author: 'Redgrund',
    authorUrl: 'https://sketchfab.com/redgrund',
    sourceUrl: 'https://sketchfab.com/3d-models/scuderia-ferrari-f1-sf23-2023-ecb0f812bc454331bbe721655b0780ec',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  'emerald-am23': {
    file: 'amr23.glb',
    orientation: 'source',
    ruleset: '2022-2025',
    name: 'Aston Martin F1 AMR23 2023',
    author: 'Redgrund',
    authorUrl: 'https://sketchfab.com/redgrund',
    sourceUrl: 'https://sketchfab.com/3d-models/aston-martin-f1-amr23-2023-f6ba825a43b146a9b669934a4e1fd529',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
}

export type LoadedCarModel = {
  root: THREE.Group
  bounds: THREE.Box3
  meshes: THREE.Mesh[]
  credit: CarModelCredit
  componentNodes: SemanticComponentNodes
  componentRigAvailable: boolean
  componentRigStatus: SemanticRigStatus
  wheelNodes: SemanticWheelNodes
  wheelRigAvailable: boolean
}

export const semanticReferenceComponentIds: readonly AdjustableComponentId[] = [
  'front-wing-mainplane',
  'front-wing-flap',
  'rear-wing-mainplane',
  'rear-wing-flap',
]

/**
 * Resolve only uniquely named semantic nodes. A duplicate or missing node is
 * intentionally omitted so a malformed asset can never drive an ambiguous
 * component at runtime.
 */
export const resolveSemanticComponentNodes = (root: THREE.Object3D) => {
  const componentNodes: SemanticComponentNodes = {}
  let complete = true
  for (const id of semanticReferenceComponentIds) {
    const matches: THREE.Object3D[] = []
    root.traverse((object) => {
      if (object.name === id) matches.push(object)
    })
    if (matches.length === 1) componentNodes[id] = matches[0]
    else complete = false
  }
  return {
    componentNodes,
    componentRigAvailable: complete,
    componentRigStatus: complete ? 'available' as const : 'static' as const,
  }
}

export const resolveSemanticWheelNodes = (root: THREE.Object3D) => {
  const wheelNodes: SemanticWheelNodes = {}
  let complete = true
  for (const id of semanticWheelIds) {
    const matches: THREE.Object3D[] = []
    root.traverse((object) => {
      if (object.name === id) matches.push(object)
    })
    if (matches.length === 1) wheelNodes[id] = matches[0]
    else complete = false
  }
  return { wheelNodes, wheelRigAvailable: complete }
}

export const rotateSemanticWheels = (nodes: SemanticWheelNodes, deltaRadians: number) => {
  semanticWheelIds.forEach((id) => {
    const wheel = nodes[id]
    if (wheel) wheel.rotation.z += deltaRadians
  })
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

export const carModelCreditFor = (carId: string, ruleset: Ruleset) => {
  const requested = carModelCredits[carId]
  return requested?.ruleset === ruleset
    ? requested
    : Object.values(carModelCredits).find((candidate) => candidate.ruleset === ruleset) ?? carModelCredits['apex-r26']
}

export const disposeObject3D = (root: THREE.Object3D) => {
  const disposedMaterials = new Set<THREE.Material>()
  const disposedGeometries = new Set<THREE.BufferGeometry>()
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    if (!disposedGeometries.has(object.geometry)) {
      object.geometry.disposeBoundsTree?.()
      object.geometry.dispose()
      disposedGeometries.add(object.geometry)
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    materials.forEach((material) => {
      if (disposedMaterials.has(material)) return
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
      disposedMaterials.add(material)
    })
  })
}

export const loadHighDetailCar = async (carId: string, ruleset: Ruleset): Promise<LoadedCarModel> => {
  const credit = carModelCreditFor(carId, ruleset)
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${credit.file}`)
  const root = new THREE.Group()
  root.name = `licensed-model-${carId}`
  const model = gltf.scene
  root.add(model)

  const semanticRig = resolveSemanticComponentNodes(model)
  const semanticWheels = resolveSemanticWheelNodes(model)
  let bounds: THREE.Box3
  let size: THREE.Vector3
  if (credit.orientation === 'source') {
    model.updateMatrixWorld(true)
    bounds = new THREE.Box3().setFromObject(model)
    size = bounds.getSize(new THREE.Vector3())
    if (size.z > size.x) model.rotation.y = Math.PI / 2
    // Source assets face +X. Air enters the tunnel from -X, so turn the cars
    // to present the nose and front wing to the inlet.
    model.rotation.y += Math.PI
  }

  model.updateMatrixWorld(true)
  bounds = new THREE.Box3().setFromObject(model)
  size = bounds.getSize(new THREE.Vector3())
  model.scale.setScalar(6.35 / Math.max(size.x, size.z))
  model.updateMatrixWorld(true)
  bounds = new THREE.Box3().setFromObject(model)
  const center = bounds.getCenter(new THREE.Vector3())
  model.position.x -= center.x
  model.position.y -= bounds.min.y
  model.position.z -= center.z
  model.updateMatrixWorld(true)

  bounds = new THREE.Box3().setFromObject(model)
  const meshes: THREE.Mesh[] = []
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.castShadow = true
    object.receiveShadow = true
    meshes.push(object)
  })

  return {
    root,
    bounds,
    meshes,
    credit,
    componentNodes: semanticRig.componentNodes,
    componentRigAvailable: semanticRig.componentRigAvailable,
    componentRigStatus: semanticRig.componentRigStatus,
    wheelNodes: semanticWheels.wheelNodes,
    wheelRigAvailable: semanticWheels.wheelRigAvailable,
  }
}
