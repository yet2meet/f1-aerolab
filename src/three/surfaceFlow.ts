import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

THREE.Mesh.prototype.raycast = acceleratedRaycast
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree

export type SurfaceFlowRig = {
  group: THREE.Group
  materials: THREE.ShaderMaterial[]
  pulseMaterials: THREE.ShaderMaterial[]
  opacityMaterials: Array<{ material: THREE.MeshBasicMaterial; baseOpacity: number }>
  tracers: Array<{
    id: string
    region: FlowRegion
    curve: THREE.CatmullRomCurve3
    path: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>
    marker: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>
    pulse: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial>
    baseColor: THREE.Color
    /** Colour the tracer is drawn in before any heat: its region colour, or grey as a baseline. */
    displayColor: THREE.Color
    /** Per-sample change intensity (0–1) along the lane, or null when unchanged. */
    heat: Float32Array | null
    xRange: [number, number]
    pathBaseOpacity: number
    markerBaseOpacity: number
    phase: number
  }>
  fields: FlowField[]
  bounds: THREE.Box3
  styleOpacityScale: number
  styleFlowStrengthScale: number
  sampleCount: number
  layerCount: number
  dispose: () => void
}

export type SurfaceFlowOptions = {
  /** Height the upper lanes rise behind the last surface they cross. */
  wakeUpwashM?: number
}

export type FlowRegion = 'upper' | 'floor' | 'side-left' | 'side-right'
export type FlowChangeFocus = 'front-wing' | 'rear-wing' | 'all-wings' | 'global'

type FlowField = {
  id: string
  region: FlowRegion
  geometry: THREE.BufferGeometry
  rowCount: number
  columnCount: number
}

export type SurfaceFlowSnapshot = {
  fields: Map<string, Float32Array>
  tracers: Map<string, Float32Array>
}

export type SurfaceFlowDelta = {
  maxOffsetM: number
  meanOffsetM: number
  affectedSamples: number
}

const markerUp = new THREE.Vector3(0, 1, 0)
const PULSE_BASE_OPACITY = 0.95
const PULSES_PER_TRACER = 4
const UPPER_STANDOFF_M = 0.06
/** Largest per-sample rise or fall a trailing edge may impose on the flow leaving it. */
const TRAILING_EDGE_MAX_STEP_M = 0.06
export const WAKE_UPWASH_M = 0.32
/** Display gain applied to the rear-load trend when it drives the wake (matches the ×3 heat gain). */
export const LOAD_WAKE_TREND_GAIN = 3

/**
 * Trend-driven wake rise: scales the geometric upwash by the relative rear
 * downforce. A trend visual, not a solved wake.
 */
export const resolveLoadDrivenWakeUpwash = (rearLoadRatio: number) => THREE.MathUtils.clamp(
  WAKE_UPWASH_M * (1 + (rearLoadRatio - 1) * LOAD_WAKE_TREND_GAIN),
  0.04,
  0.7,
)

const fillMissing = (values: Array<number | null>, fallbackStart: number, fallbackEnd: number) => {
  const result = [...values]
  const known = result.map((value, index) => value === null ? -1 : index).filter((index) => index >= 0)
  if (known.length === 0) {
    return result.map((_, index) => THREE.MathUtils.lerp(fallbackStart, fallbackEnd, index / (result.length - 1)))
  }

  const first = known[0]
  const last = known[known.length - 1]
  for (let index = 0; index < first; index += 1) {
    result[index] = THREE.MathUtils.lerp(fallbackStart, result[first] as number, index / first)
  }
  for (let index = last + 1; index < result.length; index += 1) {
    result[index] = THREE.MathUtils.lerp(result[last] as number, fallbackEnd, (index - last) / (result.length - 1 - last))
  }
  for (let knownIndex = 0; knownIndex < known.length - 1; knownIndex += 1) {
    const from = known[knownIndex]
    const to = known[knownIndex + 1]
    for (let index = from + 1; index < to; index += 1) {
      result[index] = THREE.MathUtils.lerp(result[from] as number, result[to] as number, (index - from) / (to - from))
    }
  }
  return result as number[]
}

const hermite = (p0: number, m0: number, p1: number, m1: number, t: number) => {
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1
}

/**
 * Like fillMissing, but air leaving a surface keeps that surface's trailing-edge
 * slope (Kutta condition) and eases back, so a steeper wing element visibly turns
 * the flow downstream instead of being bridged by a straight line.
 */
const fillWithTrailingEdges = (
  constraints: Array<number | undefined>,
  fallbackStart: number,
  fallbackEnd: number,
) => {
  const values = fillMissing(constraints.map((value) => value ?? null), fallbackStart, fallbackEnd)
  const slopeAt = (from: number, to: number) => {
    const a = constraints[from]
    const b = constraints[to]
    if (a === undefined || b === undefined) return 0
    return THREE.MathUtils.clamp(b - a, -TRAILING_EDGE_MAX_STEP_M, TRAILING_EDGE_MAX_STEP_M)
  }
  let index = 0
  while (index < constraints.length) {
    if (constraints[index] === undefined || constraints[index + 1] !== undefined) {
      index += 1
      continue
    }
    const trailing = index
    let next = trailing + 1
    while (next < constraints.length && constraints[next] === undefined) next += 1
    const tail = next >= constraints.length
    const target = tail ? constraints.length - 1 : next
    const span = target - trailing
    const exitSlope = slopeAt(trailing - 1, trailing) * span
    const entrySlope = tail ? 0 : slopeAt(next, next + 1) * span
    const endValue = tail ? fallbackEnd : constraints[next] as number
    for (let step = 1; step < span + (tail ? 1 : 0); step += 1) {
      values[trailing + step] = hermite(constraints[trailing] as number, exitSlope, endValue, entrySlope, step / span)
    }
    index = next
  }
  return values
}

const smooth = (values: number[], passes = 2) => {
  let current = values
  for (let pass = 0; pass < passes; pass += 1) {
    current = current.map((value, index) => {
      if (index === 0 || index === current.length - 1) return value
      return current[index - 1] * 0.25 + value * 0.5 + current[index + 1] * 0.25
    })
  }
  return current
}

// Relaxes a lane like a taut band held off the body: it keeps clear of every
// sampled surface point but rises before obstacles instead of spiking over them.
const envelope = (
  values: number[],
  constraints: Array<number | undefined>,
  keep: 'above' | 'below',
  passes = 10,
) => {
  const clampToBody = (current: number[]) => current.map((value, index) => {
    const constraint = constraints[index]
    if (constraint === undefined) return value
    return keep === 'above' ? Math.max(value, constraint) : Math.min(value, constraint)
  })
  let current = clampToBody(values)
  for (let pass = 0; pass < passes; pass += 1) current = clampToBody(smooth(current, 1))
  return current
}

const knownRange = (constraints: Array<number | undefined>) => {
  const first = constraints.find((value) => value !== undefined)
  const last = [...constraints].reverse().find((value) => value !== undefined)
  return first === undefined || last === undefined ? null : { first, last }
}

const sampleXs = (minimum: number, maximum: number, count: number) => (
  Array.from({ length: count }, (_, index) => THREE.MathUtils.lerp(minimum, maximum, index / (count - 1)))
)

const smokeVertexShader = /* glsl */ `
  attribute float flowDelta;
  varying vec2 vUv;
  varying float vFlowDelta;
  void main() {
    vUv = uv;
    vFlowDelta = flowDelta;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const smokeFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uOpacity;
  uniform float uFlowStrength;
  uniform float uTransition;
  uniform float uPhase;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vFlowDelta;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.55;
    for (int octave = 0; octave < 3; octave++) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec2(19.1, 7.7);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    float travel = uTime * (0.24 + uSpeed * 0.22);
    float cloud = fbm(vec2(vUv.x * 7.0 - travel + uPhase, vUv.y * 5.2 + uPhase));
    float streakNoise = noise(vec2(vUv.x * 24.0 - travel * 3.4, vUv.y * 3.2 + uPhase * 2.0));
    float streak = smoothstep(0.48, 0.9, streakNoise + cloud * 0.35);
    float edge = smoothstep(0.0, 0.09, vUv.y) * (1.0 - smoothstep(0.91, 1.0, vUv.y));
    float inlet = smoothstep(0.0, 0.08, vUv.x);
    float outlet = 1.0 - smoothstep(0.96, 1.0, vUv.x);
    float bodyMist = smoothstep(0.08, 0.32, vUv.x) * (1.0 - smoothstep(0.88, 1.0, vUv.x));
    float density = 0.18 + cloud * 0.56 + streak * 0.48 + bodyMist * 0.16;
    float alpha = uOpacity * uFlowStrength * uTransition * density * edge * inlet * outlet;
    vec3 smoke = mix(uColor, vec3(1.0), 0.48 + cloud * 0.38);
    vec3 deltaWarm = mix(vec3(1.0, 0.92, 0.18), vec3(1.0, 0.31, 0.06), smoothstep(0.12, 0.58, vFlowDelta));
    vec3 deltaHot = mix(deltaWarm, vec3(1.0, 0.04, 0.62), smoothstep(0.58, 1.0, vFlowDelta));
    smoke = mix(smoke, deltaHot, smoothstep(0.025, 0.78, vFlowDelta) * 0.92);
    alpha *= 1.0 + smoothstep(0.04, 0.72, vFlowDelta) * 0.34;
    gl_FragColor = vec4(smoke, alpha);
  }
`

const pulseVertexShader = /* glsl */ `
  attribute float flowDelta;
  varying vec2 vUv;
  varying float vFlowDelta;
  void main() {
    vUv = uv;
    vFlowDelta = flowDelta;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Comet-shaped pulses travelling downstream along a tracer: bright head, fading tail.
const pulseFragmentShader = /* glsl */ `
  uniform float uTravel;
  uniform float uCount;
  uniform float uPhase;
  uniform float uOpacity;
  uniform float uTransition;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vFlowDelta;
  void main() {
    float s = fract(vUv.x * uCount - uTravel + uPhase);
    float tail = pow(s, 3.0) * (1.0 - smoothstep(0.94, 1.0, s));
    float ends = smoothstep(0.0, 0.04, vUv.x) * (1.0 - smoothstep(0.95, 1.0, vUv.x));
    vec3 deltaWarm = mix(vec3(1.0, 0.92, 0.18), vec3(1.0, 0.31, 0.06), smoothstep(0.12, 0.58, vFlowDelta));
    vec3 deltaHot = mix(deltaWarm, vec3(1.0, 0.04, 0.62), smoothstep(0.58, 1.0, vFlowDelta));
    vec3 base = mix(uColor, deltaHot, smoothstep(0.025, 0.78, vFlowDelta) * 0.95);
    vec3 color = mix(base, vec3(1.0), smoothstep(0.7, 0.97, s) * 0.55);
    gl_FragColor = vec4(color, uOpacity * uTransition * tail * ends);
  }
`

const makePulseMaterial = (color: number, phase: number, count: number) => new THREE.ShaderMaterial({
  uniforms: {
    uTravel: { value: 0 },
    uCount: { value: count },
    uPhase: { value: phase },
    uOpacity: { value: PULSE_BASE_OPACITY },
    uTransition: { value: 1 },
    uColor: { value: new THREE.Color(color) },
  },
  vertexShader: pulseVertexShader,
  fragmentShader: pulseFragmentShader,
  transparent: true,
  depthWrite: false,
  depthTest: true,
})

const makeSmokeMaterial = (color: number, opacity: number, phase: number) => new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uSpeed: { value: 1 },
    uOpacity: { value: opacity },
    uFlowStrength: { value: 1 },
    uTransition: { value: 1 },
    uPhase: { value: phase },
    uColor: { value: new THREE.Color(color) },
  },
  vertexShader: smokeVertexShader,
  fragmentShader: smokeFragmentShader,
  transparent: true,
  depthWrite: false,
  depthTest: true,
  side: THREE.DoubleSide,
  blending: THREE.NormalBlending,
})

const makeSurfaceGeometry = (rows: THREE.Vector3[][], offset: THREE.Vector3) => {
  const rowCount = rows.length
  const columnCount = rows[0]?.length ?? 0
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  rows.forEach((row, rowIndex) => {
    row.forEach((point, columnIndex) => {
      positions.push(point.x + offset.x, point.y + offset.y, point.z + offset.z)
      uvs.push(columnIndex / (columnCount - 1), rowIndex / (rowCount - 1))
    })
  })

  for (let row = 0; row < rowCount - 1; row += 1) {
    for (let column = 0; column < columnCount - 1; column += 1) {
      const a = row * columnCount + column
      const b = a + 1
      const c = a + columnCount
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('flowDelta', new THREE.Float32BufferAttribute(new Float32Array(rowCount * columnCount), 1))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

const addSmokeLayers = (
  group: THREE.Group,
  materials: THREE.ShaderMaterial[],
  rows: THREE.Vector3[][],
  normal: THREE.Vector3,
  offsets: number[],
  color: number,
  opacities: number[],
  fields: FlowField[],
  idPrefix: string,
  region: FlowRegion,
) => {
  offsets.forEach((distance, layerIndex) => {
    const material = makeSmokeMaterial(color, opacities[layerIndex], materials.length * 1.713)
    const geometry = makeSurfaceGeometry(rows, normal.clone().multiplyScalar(distance))
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'continuous-volumetric-wind-sheet'
    mesh.frustumCulled = false
    mesh.renderOrder = 3 + layerIndex
    group.add(mesh)
    materials.push(material)
    fields.push({
      id: `${idPrefix}:layer-${layerIndex}`,
      region,
      geometry,
      rowCount: rows.length,
      columnCount: rows[0]?.length ?? 0,
    })
  })
}

const deltaHeatColor = (value: number) => {
  const yellow = new THREE.Color(0xffea2e)
  const orange = new THREE.Color(0xff4f0f)
  const magenta = new THREE.Color(0xff0a9d)
  return value < 0.58
    ? yellow.lerp(orange, value / 0.58)
    : orange.lerp(magenta, (value - 0.58) / 0.42)
}

/** Interpolates a lane's per-sample heat at world x (samples are evenly spaced in x). */
const heatAtX = (heat: Float32Array | null, xRange: [number, number], x: number) => {
  if (!heat || heat.length === 0) return 0
  const position = THREE.MathUtils.clamp((x - xRange[0]) / Math.max(1e-6, xRange[1] - xRange[0]), 0, 1) * (heat.length - 1)
  const index = Math.floor(position)
  const next = Math.min(heat.length - 1, index + 1)
  return THREE.MathUtils.lerp(heat[index], heat[next], position - index)
}

const heatedColor = (base: THREE.Color, intensity: number, target: THREE.Color) => {
  target.copy(base)
  if (intensity <= 0.025) return target
  return target.lerp(deltaHeatColor(intensity), THREE.MathUtils.smoothstep(intensity, 0.025, 0.78) * 0.95)
}

/** Writes the tracer's heat into its path colours and pulse attribute, so only the changed stretch lights up. */
const paintTracer = (tracer: SurfaceFlowRig['tracers'][number]) => {
  const pathGeometry = tracer.path.geometry
  const pathPositions = pathGeometry.getAttribute('position') as THREE.BufferAttribute
  const colors = new Float32Array(pathPositions.count * 3)
  const color = new THREE.Color()
  for (let index = 0; index < pathPositions.count; index += 1) {
    heatedColor(tracer.displayColor, heatAtX(tracer.heat, tracer.xRange, pathPositions.getX(index)), color)
      .toArray(colors, index * 3)
  }
  pathGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))

  const pulsePositions = tracer.pulse.geometry.getAttribute('position') as THREE.BufferAttribute
  const pulseHeat = new Float32Array(pulsePositions.count)
  if (tracer.heat) {
    for (let index = 0; index < pulsePositions.count; index += 1) {
      pulseHeat[index] = heatAtX(tracer.heat, tracer.xRange, pulsePositions.getX(index))
    }
  }
  tracer.pulse.geometry.setAttribute('flowDelta', new THREE.Float32BufferAttribute(pulseHeat, 1))
  tracer.pulse.material.uniforms.uColor.value.copy(tracer.displayColor)
  tracer.marker.material.color.copy(tracer.displayColor)
}

const addTracer = (
  group: THREE.Group,
  tracers: SurfaceFlowRig['tracers'],
  pulseMaterials: THREE.ShaderMaterial[],
  points: THREE.Vector3[],
  color: number,
  id: string,
  region: FlowRegion,
) => {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5)
  const path = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(96, points.length * 2), 0.008, 5, false),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
  path.name = 'smoke-embedded-flow-tracer'
  path.frustumCulled = false
  path.renderOrder = 12
  group.add(path)

  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(0.028, 0.105, 7),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
  )
  marker.renderOrder = 13
  marker.name = 'smoke-embedded-flow-marker'
  group.add(marker)

  const phase = (tracers.length * 0.217) % 1
  const pulseMaterial = makePulseMaterial(color, phase, PULSES_PER_TRACER)
  const pulse = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(160, points.length * 3), 0.017, 6, false),
    pulseMaterial,
  )
  pulse.name = 'smoke-embedded-flow-pulse'
  pulse.frustumCulled = false
  pulse.renderOrder = 14
  group.add(pulse)
  pulseMaterials.push(pulseMaterial)
  const tracer: SurfaceFlowRig['tracers'][number] = {
    id,
    region,
    curve,
    path,
    marker,
    pulse,
    baseColor: new THREE.Color(color),
    displayColor: new THREE.Color(color),
    heat: null,
    xRange: [points[0].x, points[points.length - 1].x],
    pathBaseOpacity: 0.58,
    markerBaseOpacity: 0.9,
    phase,
  }
  paintTracer(tracer)
  tracers.push(tracer)
}

export const buildSurfaceFlow = (
  meshes: THREE.Mesh[],
  bounds: THREE.Box3,
  reducedQuality = false,
  options: SurfaceFlowOptions = {},
): SurfaceFlowRig => {
  const wakeUpwashM = options.wakeUpwashM ?? WAKE_UPWASH_M
  const group = new THREE.Group()
  group.name = 'mesh-sampled-volumetric-wind'
  const materials: THREE.ShaderMaterial[] = []
  const pulseMaterials: THREE.ShaderMaterial[] = []
  const tracers: SurfaceFlowRig['tracers'] = []
  const fields: FlowField[] = []
  const raycaster = new THREE.Raycaster()
  raycaster.firstHitOnly = true
  meshes.forEach((mesh) => {
    if (!mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree({ targetLeafSize: 12 })
  })

  const sampleCount = 96
  const inletX = bounds.min.x - 1.55
  const outletX = bounds.max.x + 1.9
  const xs = sampleXs(inletX, outletX, sampleCount)
  const down = new THREE.Vector3(0, -1, 0)
  const up = new THREE.Vector3(0, 1, 0)
  const topOriginY = bounds.max.y + 1.2
  const floorOriginY = bounds.min.y - 0.35
  const bodyWidth = bounds.max.z - bounds.min.z

  const topLanes = Array.from({ length: 13 }, (_, index) => THREE.MathUtils.lerp(-0.96, 0.96, index / 12) * bodyWidth * 0.5)
  const topRows = topLanes.map((z, laneIndex) => {
    const constraints = xs.map((x) => {
      raycaster.set(new THREE.Vector3(x, topOriginY, z), down)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      return hit ? hit.point.y + UPPER_STANDOFF_M : undefined
    })
    const range = knownRange(constraints)
    // Free stream arrives level just above the first surface it meets, and leaves
    // with upwash behind the last one (rear wing / diffuser lift the wake).
    const start = range ? range.first + 0.1 : 0.62 + laneIndex * 0.02
    const end = range ? range.last + wakeUpwashM : 0.78 + laneIndex * 0.025
    const filled = fillWithTrailingEdges(constraints, start, end)
    const heights = envelope(filled, constraints, 'above')
    return xs.map((x, index) => new THREE.Vector3(x, heights[index], z))
  })
  addSmokeLayers(
    group,
    materials,
    topRows,
    new THREE.Vector3(0, 1, 0),
    reducedQuality ? [0, 0.09] : [0, 0.065, 0.13],
    0xcceef4,
    reducedQuality ? [0.12, 0.07] : [0.11, 0.075, 0.045],
    fields,
    'upper',
    'upper',
  )
  ;[2, 4, 6, 8, 10].forEach((rowIndex) => addTracer(
    group, tracers, pulseMaterials, topRows[rowIndex], 0x2fd6ff, `upper:row-${rowIndex}`, 'upper',
  ))

  const floorLanes = Array.from({ length: 9 }, (_, index) => THREE.MathUtils.lerp(-0.8, 0.8, index / 8) * bodyWidth * 0.43)
  const floorRows = floorLanes.map((z) => {
    const constraints = xs.map((x) => {
      raycaster.set(new THREE.Vector3(x, floorOriginY, z), up)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      return hit ? Math.max(0.035, hit.point.y - 0.035) : undefined
    })
    const range = knownRange(constraints)
    const end = range ? Math.max(0.26, range.last + 0.18) : 0.26
    const filled = fillMissing(constraints.map((value) => value ?? null), 0.09, end)
    const heights = envelope(filled, constraints, 'below').map((value) => Math.max(0.03, value))
    return xs.map((x, index) => new THREE.Vector3(x, heights[index], z))
  })
  addSmokeLayers(
    group,
    materials,
    floorRows,
    new THREE.Vector3(0, -1, 0),
    reducedQuality ? [0] : [0, 0.045],
    0xe3f3cf,
    reducedQuality ? [0.13] : [0.12, 0.07],
    fields,
    'floor',
    'floor',
  )
  ;[2, 4, 6].forEach((rowIndex) => addTracer(
    group, tracers, pulseMaterials, floorRows[rowIndex], 0xb8ff2e, `floor:row-${rowIndex}`, 'floor',
  ))

  const outsideZ = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) + 0.8
  for (const side of [-1, 1]) {
    const sideRows = Array.from({ length: 8 }, (_, laneIndex) => {
      const y = 0.22 + laneIndex * 0.22
      const direction = new THREE.Vector3(0, 0, -side)
      const constraints = xs.map((x) => {
        raycaster.set(new THREE.Vector3(x, y, side * outsideZ), direction)
        const hit = raycaster.intersectObjects(meshes, false)[0]
        return hit ? side * hit.point.z + 0.045 : undefined
      })
      const range = knownRange(constraints)
      const fallback = outsideZ - 0.1 + laneIndex * 0.045
      const start = range ? Math.min(fallback, range.first + 0.12) : fallback
      const end = range ? range.last + 0.3 : fallback + 0.3
      const filled = fillMissing(constraints.map((value) => value ?? null), start, end)
      const widths = envelope(filled, constraints, 'above')
      return xs.map((x, index) => new THREE.Vector3(x, y, side * widths[index]))
    })
    const region = side < 0 ? 'side-left' : 'side-right'
    ;[1, 3].forEach((rowIndex) => addTracer(
      group, tracers, pulseMaterials, sideRows[rowIndex], 0xd9b8ff, `${region}:row-${rowIndex}`, region,
    ))
  }

  const disposedMaterials = new Set<THREE.Material>()
  const disposedGeometries = new Set<THREE.BufferGeometry>()
  const opacityMaterials: SurfaceFlowRig['opacityMaterials'] = []
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
    meshMaterials.forEach((material) => {
      if (material instanceof THREE.MeshBasicMaterial) {
        opacityMaterials.push({ material, baseOpacity: material.opacity })
      }
    })
  })
  const dispose = () => {
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      if (!disposedGeometries.has(object.geometry)) {
        object.geometry.dispose()
        disposedGeometries.add(object.geometry)
      }
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
      meshMaterials.forEach((material) => {
        if (!disposedMaterials.has(material)) material.dispose()
        disposedMaterials.add(material)
      })
    })
  }

  return {
    group,
    materials,
    pulseMaterials,
    opacityMaterials,
    tracers,
    fields,
    bounds: bounds.clone(),
    styleOpacityScale: 1,
    styleFlowStrengthScale: 1,
    sampleCount: sampleCount * (topRows.length + floorRows.length + 16),
    layerCount: materials.length,
    dispose,
  }
}

const copyVectorArray = (points: THREE.Vector3[]) => {
  const values = new Float32Array(points.length * 3)
  points.forEach((point, index) => point.toArray(values, index * 3))
  return values
}

export const captureSurfaceFlowSnapshot = (rig: SurfaceFlowRig): SurfaceFlowSnapshot => ({
  fields: new Map(rig.fields.map(({ id, geometry }) => [
    id,
    new Float32Array((geometry.getAttribute('position') as THREE.BufferAttribute).array),
  ])),
  tracers: new Map(rig.tracers.map(({ id, curve }) => [id, copyVectorArray(curve.points)])),
})

const downstreamStart = (focus: FlowChangeFocus) => {
  if (focus === 'front-wing') return 0.08
  if (focus === 'rear-wing') return 0.64
  return 0
}

const displayDeltaForRows = (
  current: Float32Array,
  baseline: Float32Array,
  rowCount: number,
  columnCount: number,
  bounds: THREE.Box3,
  focus: FlowChangeFocus,
  displayGain: number,
) => {
  const output = new Float32Array(rowCount * columnCount)
  let maxOffsetM = 0
  let sumOffsetM = 0
  let affectedSamples = 0
  const rangeX = Math.max(0.001, bounds.max.x - bounds.min.x)
  const start = downstreamStart(focus)

  for (let row = 0; row < rowCount; row += 1) {
    let carried = 0
    for (let column = 0; column < columnCount; column += 1) {
      const index = row * columnCount + column
      const offset = index * 3
      const dx = current[offset] - baseline[offset]
      const dy = current[offset + 1] - baseline[offset + 1]
      const dz = current[offset + 2] - baseline[offset + 2]
      const distance = Math.hypot(dx, dy, dz)
      const xProgress = (current[offset] - bounds.min.x) / rangeX
      const isDownstream = xProgress >= start
      if (isDownstream) {
        maxOffsetM = Math.max(maxOffsetM, distance)
        if (distance > 0.00025) {
          sumOffsetM += distance
          affectedSamples += 1
        }
      }
      carried = isDownstream ? Math.max(distance, carried * 0.9) : 0
      output[index] = THREE.MathUtils.clamp((carried * displayGain) / 0.12, 0, 1)
    }
  }
  return { output, maxOffsetM, sumOffsetM, affectedSamples }
}

export const applySurfaceFlowDelta = (
  rig: SurfaceFlowRig,
  baseline: SurfaceFlowSnapshot,
  focus: FlowChangeFocus,
  displayGain = 3,
): SurfaceFlowDelta => {
  let maxOffsetM = 0
  let sumOffsetM = 0
  let affectedSamples = 0

  rig.tracers.forEach((tracer) => {
    tracer.displayColor.copy(tracer.baseColor)
    tracer.heat = null
    tracer.path.material.opacity = tracer.pathBaseOpacity
    tracer.marker.material.opacity = tracer.markerBaseOpacity
    paintTracer(tracer)
  })

  rig.fields.forEach((field) => {
    const current = (field.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const previous = baseline.fields.get(field.id)
    if (!previous || previous.length !== current.length) return
    const delta = displayDeltaForRows(
      current,
      previous,
      field.rowCount,
      field.columnCount,
      rig.bounds,
      focus,
      displayGain,
    )
    field.geometry.setAttribute('flowDelta', new THREE.Float32BufferAttribute(delta.output, 1))
    maxOffsetM = Math.max(maxOffsetM, delta.maxOffsetM)
    sumOffsetM += delta.sumOffsetM
    affectedSamples += delta.affectedSamples
  })

  rig.tracers.forEach((tracer) => {
    const previous = baseline.tracers.get(tracer.id)
    if (!previous || previous.length !== tracer.curve.points.length * 3) return
    const current = copyVectorArray(tracer.curve.points)
    const delta = displayDeltaForRows(
      current,
      previous,
      1,
      tracer.curve.points.length,
      rig.bounds,
      focus,
      displayGain,
    )
    const intensity = Math.max(...delta.output)
    if (intensity > 0.025) {
      tracer.heat = delta.output
      tracer.path.material.opacity = 0.64 + intensity * 0.24
    }
    paintTracer(tracer)
    maxOffsetM = Math.max(maxOffsetM, delta.maxOffsetM)
  })

  return {
    maxOffsetM,
    meanOffsetM: affectedSamples > 0 ? sumOffsetM / affectedSamples : 0,
    affectedSamples,
  }
}

export const setSurfaceFlowBaselineStyle = (rig: SurfaceFlowRig) => {
  const baselineColor = new THREE.Color(0x8d91b8)
  rig.styleOpacityScale = 0.42
  rig.styleFlowStrengthScale = 0.55
  rig.materials.forEach((material) => {
    material.uniforms.uColor.value.copy(baselineColor)
  })
  rig.fields.forEach(({ geometry }) => {
    const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count
    geometry.setAttribute('flowDelta', new THREE.Float32BufferAttribute(new Float32Array(count), 1))
  })
  rig.tracers.forEach((tracer) => {
    tracer.displayColor.copy(baselineColor)
    tracer.heat = null
    paintTracer(tracer)
  })
}

export const setSurfaceFlowOpacity = (rig: SurfaceFlowRig, opacity: number) => {
  const clamped = THREE.MathUtils.clamp(opacity, 0, 1)
  rig.materials.forEach((material) => {
    material.uniforms.uTransition.value = clamped * rig.styleOpacityScale
  })
  rig.opacityMaterials.forEach(({ material, baseOpacity }) => {
    material.opacity = baseOpacity * rig.styleOpacityScale * clamped
  })
  rig.pulseMaterials.forEach((material) => {
    material.uniforms.uTransition.value = clamped * rig.styleOpacityScale
  })
}

export const updateSurfaceFlow = (
  rig: SurfaceFlowRig,
  elapsed: number,
  speedKph: number,
  reducedMotion: boolean,
) => {
  rig.materials.forEach((material) => {
    material.uniforms.uTime.value = reducedMotion ? 0 : elapsed
    material.uniforms.uSpeed.value = 0.45 + speedKph / 210
    material.uniforms.uFlowStrength.value = (
      0.18 + THREE.MathUtils.clamp(speedKph / 260, 0, 1) * 0.82
    ) * rig.styleFlowStrengthScale
  })
  const flowRate = reducedMotion ? 0 : 0.022 + speedKph / 5200
  rig.tracers.forEach((tracer, index) => {
    const { curve, marker, pulse, phase } = tracer
    const travel = elapsed * flowRate * (0.9 + index * 0.018)
    pulse.material.uniforms.uTravel.value = travel * PULSES_PER_TRACER
    const progress = (phase + travel) % 1
    marker.position.copy(curve.getPointAt(progress))
    marker.quaternion.setFromUnitVectors(markerUp, curve.getTangentAt(progress).normalize())
    if (tracer.heat) {
      heatedColor(tracer.displayColor, heatAtX(tracer.heat, tracer.xRange, marker.position.x), marker.material.color)
    }
  })
}
