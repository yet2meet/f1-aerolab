import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  carModelCredits,
  carModelCreditFor,
  resolveSemanticComponentNodes,
  resolveSemanticWheelNodes,
  rotateSemanticWheels,
} from './highDetailCar'

describe('high-detail model ruleset guard', () => {
  it('keeps 2026 runs on 2026 source models', () => {
    expect(carModelCreditFor('apex-r26', '2026').name).toContain('2026')
    expect(carModelCreditFor('vortex-vx', '2026').name).toContain('2026')
  })

  it('keeps legacy runs on 2022-2025 source models even for a stale car id', () => {
    const credit = carModelCreditFor('apex-r26', '2022-2025')

    expect(credit.ruleset).toBe('2022-2025')
    expect(credit.name).toMatch(/2023/)
  })

  it('uses the web-oriented RB22 semantic asset without the source flip', () => {
    expect(carModelCredits['apex-r26'].file).toBe('rb22-wheels-rigged.glb')
    expect(carModelCredits['apex-r26'].orientation).toBe('web')
  })

  it('accepts only uniquely named reference component nodes', () => {
    const root = new THREE.Group()
    const mainplane = new THREE.Group()
    mainplane.name = 'front-wing-mainplane'
    const flap = new THREE.Group()
    flap.name = 'front-wing-flap'
    const rearMainplane = new THREE.Group()
    rearMainplane.name = 'rear-wing-mainplane'
    const rearFlap = new THREE.Group()
    rearFlap.name = 'rear-wing-flap'
    root.add(mainplane, flap, rearMainplane, rearFlap)

    const resolved = resolveSemanticComponentNodes(root)
    expect(resolved.componentRigAvailable).toBe(true)
    expect(resolved.componentRigStatus).toBe('available')
    expect(resolved.componentNodes['front-wing-mainplane']).toBe(mainplane)
    expect(resolved.componentNodes['front-wing-flap']).toBe(flap)
    expect(resolved.componentNodes['rear-wing-mainplane']).toBe(rearMainplane)
    expect(resolved.componentNodes['rear-wing-flap']).toBe(rearFlap)

    const duplicate = new THREE.Group()
    duplicate.name = 'front-wing-mainplane'
    root.add(duplicate)
    const invalid = resolveSemanticComponentNodes(root)
    expect(invalid.componentRigAvailable).toBe(false)
    expect(invalid.componentRigStatus).toBe('static')
    expect(invalid.componentNodes['front-wing-mainplane']).toBeUndefined()
    expect(invalid.componentNodes['front-wing-flap']).toBe(flap)
    expect(invalid.componentNodes['rear-wing-mainplane']).toBe(rearMainplane)
    expect(invalid.componentNodes['rear-wing-flap']).toBe(rearFlap)
  })

  it('keeps reference wheel nodes independent from aerodynamic component types', () => {
    const root = new THREE.Group()
    const wheelIds = [
      'wheel-front-left',
      'wheel-front-right',
      'wheel-rear-left',
      'wheel-rear-right',
    ]
    const wheels = wheelIds.map((id) => {
      const wheel = new THREE.Group()
      wheel.name = id
      root.add(wheel)
      return wheel
    })

    const resolved = resolveSemanticWheelNodes(root)
    expect(resolved.wheelRigAvailable).toBe(true)
    rotateSemanticWheels(resolved.wheelNodes, -0.25)
    wheels.forEach((wheel) => {
      expect(wheel.rotation.x).toBe(0)
      expect(wheel.rotation.y).toBe(0)
      expect(wheel.rotation.z).toBe(-0.25)
    })

    const duplicate = new THREE.Group()
    duplicate.name = 'wheel-front-left'
    root.add(duplicate)
    const invalid = resolveSemanticWheelNodes(root)
    expect(invalid.wheelRigAvailable).toBe(false)
    expect(invalid.wheelNodes['wheel-front-left']).toBeUndefined()
    expect(invalid.wheelNodes['wheel-front-right']).toBe(wheels[1])
  })
})
