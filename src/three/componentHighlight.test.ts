import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cars, defaultParams } from '../data/cars'
import { calculateAero } from '../lib/aero'
import { createComponentChangeOverlay, resolveChangedWingComponents } from './componentHighlight'
import { applyComponentPose, resolveComponentPose, type SemanticComponentNodes } from './componentRig'

const setup = () => {
  const car = cars[0]
  const params = defaultParams(car)
  const result = calculateAero(car, params)
  const root = new THREE.Group()
  const nodes: SemanticComponentNodes = {}
  for (const id of ['front-wing-mainplane', 'front-wing-flap', 'rear-wing-mainplane', 'rear-wing-flap'] as const) {
    const node = new THREE.Group()
    node.name = id
    node.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 1)))
    root.add(node)
    nodes[id] = node
  }
  return { params, result, root, nodes }
}

describe('component change overlay', () => {
  it('reports only wing elements whose pose changed', () => {
    const { params, result, nodes } = setup()
    const before = resolveComponentPose(params, result)
    params.garage.frontFlapPercent += 20
    const after = resolveComponentPose(params, result)

    expect(resolveChangedWingComponents(nodes, before, after)).toEqual(['front-wing-flap'])
    expect(resolveChangedWingComponents(nodes, before, before)).toEqual([])
    expect(createComponentChangeOverlay(nodes, before, before)).toBeNull()
  })

  it('places a ghost at the previous pose and a highlight on the adjusted part, then cleans up', () => {
    const { params, result, root, nodes } = setup()
    const before = resolveComponentPose(params, result)
    params.garage.rearWingLoadPercent = 100
    const after = resolveComponentPose(params, result)
    applyComponentPose(nodes, after)
    const childCountBefore = root.children.length

    const overlay = createComponentChangeOverlay(nodes, before, after)
    expect(overlay?.componentIds).toEqual(['rear-wing-mainplane', 'rear-wing-flap'])

    const ghost = root.getObjectByName('rear-wing-flap:previous-pose-ghost') as THREE.Object3D
    expect(ghost.rotation.z).toBeCloseTo(before.rearWingFlapRotationZ)
    expect(nodes['rear-wing-flap']?.rotation.z).toBeCloseTo(after.rearWingFlapRotationZ)
    expect(root.getObjectsByProperty('name', 'rear-wing-flap:adjusted-highlight')).toHaveLength(1)

    overlay?.setOpacity(0)
    expect(ghost.visible).toBe(false)
    overlay?.dispose()
    expect(root.children).toHaveLength(childCountBefore)
    expect(root.getObjectsByProperty('name', 'rear-wing-flap:adjusted-highlight')).toHaveLength(0)
  })
})
