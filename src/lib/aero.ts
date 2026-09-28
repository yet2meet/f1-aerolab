import type { AeroResult, CarSpec, SimulationParams } from '../types'

export const AIR_DENSITY_KG_M3 = 1.225
export const GRAVITY_M_S2 = 9.81

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const finiteOr = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback

/**
 * A transparent, relative trend model. It is intentionally not a CFD solver:
 * it only makes setup direction and trade-offs visible for the workbench.
 */
export const calculateAero = (car: CarSpec, params: SimulationParams): AeroResult => {
  const speedKph = clamp(finiteOr(params.run.speedKph, 0), 0, 360)
  const massKg = clamp(finiteOr(params.run.massKg, car.massKg), 740, 900)
  const frontRideHeightMm = clamp(finiteOr(params.garage.frontRideHeightMm, 35), 15, 70)
  const rearRideHeightMm = clamp(finiteOr(params.garage.rearRideHeightMm, 42), 20, 90)
  const stiffness = clamp(finiteOr(params.garage.suspensionStiffnessPercent, 50), 0, 100)
  const antiRoll = clamp(finiteOr(params.garage.antiRollBarPercent, 50), 0, 100)
  const tirePressurePsi = clamp(finiteOr(params.garage.tirePressurePsi, 22), 18, 28)
  const brakeBias = clamp(finiteOr(params.driver.brakeBiasFrontPercent, 55), 45, 60)
  const frontWingAngleDeg = clamp(finiteOr(params.garage.frontWingAngleDeg, 12), 5, 25)
  const frontFlapPercent = clamp(finiteOr(params.garage.frontFlapPercent, 50), 0, 100)
  const rearWingLoadPercent = clamp(finiteOr(params.garage.rearWingLoadPercent, 55), 0, 100)
  const floorThroatSeal = clamp(finiteOr(params.design.floorThroatSealPercent, 50), 0, 100)
  const floorEdgeSeal = clamp(finiteOr(params.design.floorEdgeSealPercent, 50), 0, 100)
  const diffuserAngleDeg = clamp(finiteOr(params.design.diffuserAngleDeg, 10), 5, 15)

  const velocityMs = speedKph / 3.6
  const dynamicPressurePa = 0.5 * AIR_DENSITY_KG_M3 * velocityMs ** 2
  const rideHeightAverageMm = (frontRideHeightMm + rearRideHeightMm) / 2
  const rakeMm = rearRideHeightMm - frontRideHeightMm

  // Lower, stable platforms keep the floor working. Positive rake contributes a small,
  // bounded benefit; the clamp keeps the demo inside a plausible setup window.
  const rideHeightDelta =
    (car.referenceRideHeightMm - rideHeightAverageMm) / car.referenceRideHeightMm
  const rakeContribution = clamp(rakeMm / 35, -0.35, 0.35) * 0.1
  const groundEffectFactor = clamp(
    1 + rideHeightDelta * car.groundEffectSensitivity + rakeContribution,
    0.72,
    1.38,
  )

  // Floor throat/edge sealing and diffuser angle are separate design levers in a
  // modern ground-effect floor with venturi tunnels.
  const floorLoadFactor = clamp(
    0.86 + floorThroatSeal * 0.00125 + floorEdgeSeal * 0.00135 +
      ((diffuserAngleDeg - 10) / 5) * car.diffuserSensitivity,
    0.86,
    1.22,
  )
  const platformStabilityFactor = clamp(
    0.9 + stiffness * 0.00045 + antiRoll * 0.00035,
    0.9,
    1.0,
  )

  const frontWingLoadFactor = clamp(
    1 + ((frontWingAngleDeg - 12) / 12) * 0.22 * car.wingSensitivity +
      ((frontFlapPercent - 50) / 100) * 0.1,
    0.82,
    1.3,
  )
  const rearWingLoadFactor = clamp(
    1 + ((rearWingLoadPercent - 55) / 100) * 0.28 * car.wingSensitivity,
    0.82,
    1.3,
  )
  const frontWingDragFactor = clamp(
    1 + ((frontWingAngleDeg - 12) / 12) * 0.18 * car.wingSensitivity +
      ((frontFlapPercent - 50) / 100) * 0.07,
    0.82,
    1.28,
  )
  const rearWingDragFactor = clamp(
    1 + ((rearWingLoadPercent - 55) / 100) * 0.22 * car.wingSensitivity,
    0.82,
    1.28,
  )

  let frontAeroLoadFactor = frontWingLoadFactor
  let rearAeroLoadFactor = rearWingLoadFactor
  let frontAeroDragFactor = frontWingDragFactor
  let rearAeroDragFactor = rearWingDragFactor
  let activeAeroLabel = '2026 · 弯道高下压力'
  const activeAeroMode = params.driver.activeAeroMode
  const drsActive = params.ruleset === '2022-2025' && params.garage.drsOpen

  if (params.ruleset === '2026') {
    if (activeAeroMode === 'straight') {
      // 2026 active aero is coupled front/rear. Both wing assemblies move to
      // a lower-drag straight-line state.
      frontAeroLoadFactor *= 0.93
      rearAeroLoadFactor *= 0.76
      frontAeroDragFactor *= 0.88
      rearAeroDragFactor *= 0.72
      activeAeroLabel = '2026 · 直道主动低阻'
    }
  } else if (drsActive) {
    // Legacy 2022–2025 DRS is kept as an explicit selectable ruleset only.
    rearAeroLoadFactor *= 0.92
    rearAeroDragFactor *= 0.76
    activeAeroLabel = '2022–25 · DRS 开启'
  } else {
    activeAeroLabel = '2022–25 · DRS 关闭'
  }

  const floorCl = car.baseCl * groundEffectFactor * floorLoadFactor * platformStabilityFactor
  const frontDownforceCoefficient = floorCl * car.frontBias * frontAeroLoadFactor
  const rearDownforceCoefficient = floorCl * (1 - car.frontBias) * rearAeroLoadFactor
  const effectiveCl = Math.max(0, frontDownforceCoefficient + rearDownforceCoefficient)

  const diffuserDragFactor = 1 + ((diffuserAngleDeg - 10) / 5) * 0.08
  const edgeDragFactor = 1 - (floorEdgeSeal / 100) * 0.025
  const baseDragCoefficient = car.baseCd * diffuserDragFactor * edgeDragFactor
  const effectiveCd = Math.max(
    0.05,
    baseDragCoefficient * (0.35 * frontAeroDragFactor + 0.65 * rearAeroDragFactor),
  )

  const downforceN = dynamicPressurePa * car.areaM2 * effectiveCl
  const frontDownforceN =
    dynamicPressurePa * car.areaM2 * Math.max(0, frontDownforceCoefficient)
  const rearDownforceN = dynamicPressurePa * car.areaM2 * Math.max(0, rearDownforceCoefficient)
  const aeroDragN = dynamicPressurePa * car.areaM2 * effectiveCd

  // Tyres add rolling resistance. Their pressure has a minimum near 22 psi; the
  // garage pressure setting only modifies this tyre rolling term.
  const pressureOffset = (tirePressurePsi - 22) / 4
  const rollingCoefficient = car.tireRollingCoefficient + pressureOffset ** 2 * 0.0012
  const staticWeightN = massKg * GRAVITY_M_S2
  const rollingResistanceN = speedKph > 0 ? staticWeightN * rollingCoefficient : 0
  const totalDragN = speedKph > 0 ? aeroDragN + rollingResistanceN : 0
  const totalVerticalLoadN = staticWeightN + downforceN
  const frontBiasPercent =
    downforceN > 0 ? (frontDownforceN / downforceN) * 100 : car.frontBias * 100

  return {
    ruleset: params.ruleset,
    activeAeroMode,
    activeAeroLabel,
    velocityMs,
    dynamicPressurePa,
    effectiveCd,
    effectiveCl,
    downforceN,
    frontDownforceN,
    rearDownforceN,
    aeroDragN,
    rollingResistanceN,
    totalDragN,
    staticWeightN,
    totalVerticalLoadN,
    downforceToDrag: totalDragN > 0 ? downforceN / totalDragN : 0,
    frontBiasPercent,
    rideHeightAverageMm,
    rakeMm,
    groundEffectFactor,
    floorLoadFactor,
    platformStabilityFactor,
    brakeBiasFrontPercent: brakeBias,
    tirePressurePsi,
    drsActive,
  }
}

/**
 * Rear downforce relative to a neutral rear wing (55 %, DRS closed / corner
 * mode) with everything else unchanged. Speed cancels out, so a fixed
 * reference speed keeps the ratio defined when the car is stationary.
 */
export const rearWingLoadRatio = (car: CarSpec, params: SimulationParams) => {
  const run = { ...params.run, speedKph: 200 }
  const current = calculateAero(car, { ...params, run })
  const neutral = calculateAero(car, {
    ...params,
    run,
    driver: { ...params.driver, activeAeroMode: 'corner' },
    garage: { ...params.garage, rearWingLoadPercent: 55, drsOpen: false },
  })
  return neutral.rearDownforceN > 0 ? current.rearDownforceN / neutral.rearDownforceN : 1
}
