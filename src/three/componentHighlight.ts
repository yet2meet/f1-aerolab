import * as THREE from 'three'
import {
  applyComponentPose,
  type AdjustableComponentId,
  type ComponentPose,
  type SemanticComponentNodes,
} from './componentRig'

const GHOST_BASE_OPACITY = 0.3
const HIGHLIGHT_BASE_OPACITY = 0.5
const POSE_EPSILON_RAD = 1e-4

const poseValueByComponent: Partial<Record<AdjustableComponentId, (pose: ComponentPose) => number>> = {
  'front-wing-mainplane': (pose) => pose.frontWingMainplaneRotationZ,
  'front-wing-flap': (pose) => pose.frontWingFlapRotationZ,
  'rear-wing-mainplane': (pose) => pose.rearWingMainplaneRotationZ,
  'rear-wing-flap': (pose) => pose.rearWingFlapRotationZ,
}

/** Wing elements whose pose actually differs between the two states and exist on the asset. */
export const resolveChangedWingComponents = (
  nodes: SemanticComponentNodes,
  previous: ComponentPose,
  current: ComponentPose,
): AdjustableComponentId[] => (
  (Object.keys(poseValueByComponent) as AdjustableComponentId[]).filter((id) => {
    const read = poseValueByComponent[id]
    return Boolean(nodes[id] && read && Math.abs(read(previous) - read(current)) > POSE_EPSILON_RAD)
  })
)

export type ComponentChangeOverlay = {
  componentIds: AdjustableComponentId[]
  setOpacity: (opacity: number) => void
  dispose: () => void
}

/**
 * Marks adjusted wing elements: a translucent ghost at the previous pose next to
 * a glowing shell on the current part. Geometry is shared with the asset, so
 * disposal only releases the overlay materials.
 */
export const createComponentChangeOverlay = (
  nodes: SemanticComponentNodes,
  previous: ComponentPose,
  current: ComponentPose,
): ComponentChangeOverlay | null => {
  const componentIds = resolveChangedWingComponents(nodes, previous, current)
  if (componentIds.length === 0) return null

  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0x8d91b8,
    transparent: true,
    opacity: GHOST_BASE_OPACITY,
    depthWrite: false,
    // X-ray: endplates hide wing profiles from the side, so draw through them.
    depthTest: false,
  })
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xff4f0f,
    transparent: true,
    opacity: HIGHLIGHT_BASE_OPACITY,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  })
  const added: THREE.Object3D[] = []

  componentIds.forEach((id) => {
    const node = nodes[id]
    if (!node?.parent) return

    const ghost = node.clone(true)
    ghost.name = `${id}:previous-pose-ghost`
    ghost.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      object.material = ghostMaterial
      object.castShadow = false
      object.receiveShadow = false
      object.renderOrder = 20
    })
    node.parent.add(ghost)
    applyComponentPose({ [id]: ghost }, previous)
    added.push(ghost)

    const partMeshes: THREE.Mesh[] = []
    node.traverse((object) => {
      if (object instanceof THREE.Mesh) partMeshes.push(object)
    })
    partMeshes.forEach((mesh) => {
      const shell = new THREE.Mesh(mesh.geometry, highlightMaterial)
      shell.name = `${id}:adjusted-highlight`
      shell.renderOrder = 21
      mesh.add(shell)
      added.push(shell)
    })
  })

  return {
    componentIds,
    setOpacity: (opacity) => {
      const clamped = THREE.MathUtils.clamp(opacity, 0, 1)
      ghostMaterial.opacity = GHOST_BASE_OPACITY * clamped
      highlightMaterial.opacity = HIGHLIGHT_BASE_OPACITY * clamped
      added.forEach((object) => { object.visible = clamped > 0.001 })
    },
    dispose: () => {
      added.forEach((object) => object.removeFromParent())
      ghostMaterial.dispose()
      highlightMaterial.dispose()
    },
  }
}
