export type Ruleset = '2026' | '2022-2025'
export type ActiveAeroMode = 'straight' | 'corner'

/** Run conditions supplied by the circuit simulation. Values are bounded in the UI. */
export type RunConditions = {
  speedKph: number
  massKg: number
}

/** Driver/on-track choices. Active aero mode is a 2026 state selection. */
export type DriverControls = {
  activeAeroMode: ActiveAeroMode
  brakeBiasFrontPercent: number
}

/** Garage setup choices that define the mechanical and wing trim. */
export type GarageSetup = {
  frontRideHeightMm: number
  rearRideHeightMm: number
  suspensionStiffnessPercent: number
  antiRollBarPercent: number
  tirePressurePsi: number
  frontWingAngleDeg: number
  frontFlapPercent: number
  rearWingLoadPercent: number
  drsOpen: boolean
}

/** Controls the modern ground-effect floor and diffuser design intent. */
export type AeroDesign = {
  floorThroatSealPercent: number
  floorEdgeSealPercent: number
  diffuserAngleDeg: number
}

export type SimulationParams = {
  ruleset: Ruleset
  run: RunConditions
  driver: DriverControls
  garage: GarageSetup
  design: AeroDesign
}

export type CarSpec = {
  id: string
  ruleset: Ruleset
  name: string
  code: string
  accent: string
  massKg: number
  referenceRideHeightMm: number
  areaM2: number
  baseCd: number
  baseCl: number
  frontBias: number
  groundEffectSensitivity: number
  diffuserSensitivity: number
  wingSensitivity: number
  tireRollingCoefficient: number
  description: string
  tags: string[]
}

export type AeroResult = {
  ruleset: Ruleset
  activeAeroMode: ActiveAeroMode
  activeAeroLabel: string
  velocityMs: number
  dynamicPressurePa: number
  effectiveCd: number
  effectiveCl: number
  downforceN: number
  frontDownforceN: number
  rearDownforceN: number
  aeroDragN: number
  rollingResistanceN: number
  totalDragN: number
  staticWeightN: number
  totalVerticalLoadN: number
  downforceToDrag: number
  frontBiasPercent: number
  rideHeightAverageMm: number
  rakeMm: number
  groundEffectFactor: number
  floorLoadFactor: number
  platformStabilityFactor: number
  brakeBiasFrontPercent: number
  tirePressurePsi: number
  drsActive: boolean
}

export type Comparison = {
  downforceN: number
  totalDragN: number
  downforceToDrag: number
  totalVerticalLoadN: number
}
