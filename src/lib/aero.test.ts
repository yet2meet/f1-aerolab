import { describe, expect, it } from 'vitest'
import { cars, defaultParams } from '../data/cars'
import { calculateAero, rearWingLoadRatio } from './aero'

const car = cars[0]
const setup = () => defaultParams(car)

describe('calculateAero', () => {
  it('returns zero aero and rolling resistance at standstill while retaining static weight', () => {
    const params = setup()
    params.run.speedKph = 0

    const result = calculateAero(car, params)

    expect(result.dynamicPressurePa).toBe(0)
    expect(result.downforceN).toBe(0)
    expect(result.aeroDragN).toBe(0)
    expect(result.rollingResistanceN).toBe(0)
    expect(result.totalDragN).toBe(0)
    expect(result.staticWeightN).toBeGreaterThan(0)
  })

  it('follows the expected speed-squared trend', () => {
    const low = setup()
    low.run.speedKph = 160
    const high = setup()
    high.run.speedKph = 320

    const lowResult = calculateAero(car, low)
    const highResult = calculateAero(car, high)

    expect(highResult.dynamicPressurePa / lowResult.dynamicPressurePa).toBeCloseTo(4, 1)
    expect(highResult.downforceN / lowResult.downforceN).toBeCloseTo(4, 1)
  })

  it('increases floor load when ride height is reduced in the normal window', () => {
    const low = setup()
    low.garage.frontRideHeightMm = 20
    low.garage.rearRideHeightMm = 30
    const high = setup()
    high.garage.frontRideHeightMm = 50
    high.garage.rearRideHeightMm = 65

    expect(calculateAero(car, low).downforceN).toBeGreaterThan(calculateAero(car, high).downforceN)
  })

  it('keeps front and rear loads additive and responds to wing controls', () => {
    const params = setup()
    const baseline = calculateAero(car, params)
    params.garage.frontWingAngleDeg = 22
    params.garage.frontFlapPercent = 90
    params.garage.rearWingLoadPercent = 90
    const loaded = calculateAero(car, params)

    expect(baseline.frontDownforceN + baseline.rearDownforceN).toBeCloseTo(baseline.downforceN, 5)
    expect(loaded.frontDownforceN).toBeGreaterThan(baseline.frontDownforceN)
    expect(loaded.rearDownforceN).toBeGreaterThan(baseline.rearDownforceN)
  })

  it('uses 2026 coupled active aero and keeps legacy DRS explicit', () => {
    const corner = setup()
    corner.ruleset = '2026'
    corner.driver.activeAeroMode = 'corner'
    const straight = setup()
    straight.ruleset = '2026'
    straight.driver.activeAeroMode = 'straight'
    const legacy = setup()
    legacy.ruleset = '2022-2025'
    legacy.garage.drsOpen = true

    const cornerResult = calculateAero(car, corner)
    const straightResult = calculateAero(car, straight)
    const legacyResult = calculateAero(car, legacy)

    expect(straightResult.activeAeroLabel).toContain('直道主动低阻')
    expect(straightResult.totalDragN).toBeLessThan(cornerResult.totalDragN)
    expect(legacyResult.drsActive).toBe(true)
    expect(legacyResult.activeAeroLabel).toContain('DRS 开启')
  })

  it('changes static/rolling load with mass but leaves aero force unchanged', () => {
    const light = setup()
    light.run.massKg = 750
    const heavy = setup()
    heavy.run.massKg = 890

    const lightResult = calculateAero(car, light)
    const heavyResult = calculateAero(car, heavy)

    expect(heavyResult.staticWeightN).toBeGreaterThan(lightResult.staticWeightN)
    expect(heavyResult.rollingResistanceN).toBeGreaterThan(lightResult.rollingResistanceN)
    expect(heavyResult.downforceN).toBeCloseTo(lightResult.downforceN, 6)
  })

  it('responds to floor, diffuser, suspension, tyre and brake controls', () => {
    const params = setup()
    const baseline = calculateAero(car, params)
    params.design.floorThroatSealPercent = 100
    params.design.floorEdgeSealPercent = 100
    params.design.diffuserAngleDeg = 14
    params.garage.suspensionStiffnessPercent = 100
    params.garage.antiRollBarPercent = 100
    params.garage.tirePressurePsi = 28
    params.driver.brakeBiasFrontPercent = 60
    const changed = calculateAero(car, params)

    expect(changed.downforceN).toBeGreaterThan(baseline.downforceN)
    expect(changed.rollingResistanceN).toBeGreaterThan(baseline.rollingResistanceN)
    expect(changed.brakeBiasFrontPercent).toBe(60)
  })

  it('clamps out-of-range inputs to finite, safe values', () => {
    const params = setup()
    params.run.speedKph = Number.NaN
    params.run.massKg = 2000
    params.garage.frontRideHeightMm = -50
    params.garage.rearRideHeightMm = 1000
    params.garage.frontWingAngleDeg = 100
    params.design.diffuserAngleDeg = -10
    params.driver.brakeBiasFrontPercent = 200

    const result = calculateAero(car, params)

    expect(Number.isFinite(result.downforceN)).toBe(true)
    expect(result.velocityMs).toBe(0)
    expect(result.staticWeightN).toBeCloseTo(900 * 9.81, 5)
    expect(result.rideHeightAverageMm).toBeCloseTo((15 + 90) / 2, 5)
    expect(result.totalDragN).toBe(0)
    expect(result.brakeBiasFrontPercent).toBe(60)
  })
})

describe('rearWingLoadRatio', () => {
  it('is neutral at the reference wing and follows rear load and low-drag states', () => {
    const params = setup()
    params.garage.rearWingLoadPercent = 55
    params.garage.drsOpen = false
    params.driver.activeAeroMode = 'corner'
    expect(rearWingLoadRatio(car, params)).toBeCloseTo(1, 6)

    params.garage.rearWingLoadPercent = 100
    expect(rearWingLoadRatio(car, params)).toBeGreaterThan(1)

    params.garage.rearWingLoadPercent = 55
    params.ruleset = '2026'
    params.driver.activeAeroMode = 'straight'
    expect(rearWingLoadRatio(car, params)).toBeLessThan(1)
  })

  it('stays defined when the car is stationary', () => {
    const params = setup()
    params.run.speedKph = 0
    params.garage.rearWingLoadPercent = 100
    expect(rearWingLoadRatio(car, params)).toBeGreaterThan(1)
  })
})
