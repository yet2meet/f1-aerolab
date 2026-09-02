import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

THREE.Mesh.prototype.raycast = acceleratedRaycast
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree

export type SurfaceFlowRig = {
  group: THREE.Group
  materials: THREE.ShaderMaterial[]
  opacityMaterials: Array<{ material: THREE.MeshBasicMaterial; baseOpacity: number }>
  tracers: Array<{
    id: string
    region: FlowRegion
    curve: THREE.CatmullRomCurve3
    path: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>
    marker: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>
    baseColor: THREE.Color
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

type Sample = { point: THREE.Vector3; constraint?: number }
const markerUp = new THREE.Vector3(0, 1, 0)

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

const addTracer = (
  group: THREE.Group,
  tracers: SurfaceFlowRig['tracers'],
  points: THREE.Vector3[],
  color: number,
  id: string,
  region: FlowRegion,
) => {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5)
  const path = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(72, points.length * 2), 0.007, 5, false),
    new THREE.MeshBasicMaterial({
      color,
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
  tracers.push({
    id,
    region,
    curve,
    path,
    marker,
    baseColor: new THREE.Color(color),
    pathBaseOpacity: 0.58,
    markerBaseOpacity: 0.9,
    phase: (tracers.length * 0.217) % 1,
  })
}

export const buildSurfaceFlow = (
  meshes: THREE.Mesh[],
  bounds: THREE.Box3,
  reducedQuality = false,
): SurfaceFlowRig => {
  const group = new THREE.Group()
  group.name = 'mesh-sampled-volumetric-wind'
  const materials: THREE.ShaderMaterial[] = []
  const tracers: SurfaceFlowRig['tracers'] = []
  const fields: FlowField[] = []
  const raycaster = new THREE.Raycaster()
  raycaster.firstHitOnly = true
  meshes.forEach((mesh) => {
    if (!mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree({ targetLeafSize: 12 })
  })

  const sampleCount = 44
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
    const samples: Sample[] = xs.map((x) => {
      raycaster.set(new THREE.Vector3(x, topOriginY, z), down)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      const constraint = hit?.point.y === undefined ? undefined : hit.point.y + 0.045
      return { point: new THREE.Vector3(x, constraint ?? 0, z), constraint }
    })
    const filled = smooth(fillMissing(samples.map((sample) => sample.constraint ?? null), 0.62 + laneIndex * 0.02, 0.78 + laneIndex * 0.025))
    samples.forEach((sample, index) => {
      sample.point.y = sample.constraint === undefined ? filled[index] : Math.max(sample.constraint, filled[index])
    })
    return samples.map((sample) => sample.point)
  })
  addSmokeLayers(
    group,
    materials,
    topRows,
    new THREE.Vector3(0, 1, 0),
    reducedQuality ? [0, 0.09] : [0, 0.065, 0.13],
    0xcceef4,
    reducedQuality ? [0.18, 0.1] : [0.16, 0.11, 0.07],
    fields,
    'upper',
    'upper',
  )
  ;[2, 4, 6, 8, 10].forEach((rowIndex) => addTracer(
    group, tracers, topRows[rowIndex], 0x9eeaff, `upper:row-${rowIndex}`, 'upper',
  ))

  const floorLanes = Array.from({ length: 9 }, (_, index) => THREE.MathUtils.lerp(-0.8, 0.8, index / 8) * bodyWidth * 0.43)
  const floorRows = floorLanes.map((z) => {
    const samples: Sample[] = xs.map((x) => {
      raycaster.set(new THREE.Vector3(x, floorOriginY, z), up)
      const hit = raycaster.intersectObjects(meshes, false)[0]
      const constraint = hit?.point.y === undefined ? undefined : Math.max(0.035, hit.point.y - 0.035)
      return { point: new THREE.Vector3(x, constraint ?? 0, z), constraint }
    })
    const filled = smooth(fillMissing(samples.map((sample) => sample.constraint ?? null), 0.09, 0.26))
    samples.forEach((sample, index) => {
      sample.point.y = sample.constraint === undefined ? filled[index] : Math.min(sample.constraint, filled[index])
    })
    return samples.map((sample) => sample.point)
  })
  addSmokeLayers(
    group,
    materials,
    floorRows,
    new THREE.Vector3(0, -1, 0),
    reducedQuality ? [0] : [0, 0.045],
    0xe3f3cf,
    reducedQuality ? [0.17] : [0.15, 0.09],
    fields,
    'floor',
    'floor',
  )
  ;[2, 4, 6].forEach((rowIndex) => addTracer(
    group, tracers, floorRows[rowIndex], 0xd9ff67, `floor:row-${rowIndex}`, 'floor',
  ))

  const outsideZ = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) + 0.8
  for (const side of [-1, 1]) {
    const sideRows = Array.from({ length: 8 }, (_, laneIndex) => {
      const y = 0.22 + laneIndex * 0.22
      const direction = new THREE.Vector3(0, 0, -side)
      const samples: Sample[] = xs.map((x) => {
        raycaster.set(new THREE.Vector3(x, y, side * outsideZ), direction)
        const hit = raycaster.intersectObjects(meshes, false)[0]
        const constraint = hit?.point.z === undefined ? undefined : hit.point.z + side * 0.045
        return { point: new THREE.Vector3(x, y, constraint ?? 0), constraint }
      })
      const fallback = side * (outsideZ - 0.1 + laneIndex * 0.045)
      const filled = smooth(fillMissing(samples.map((sample) => sample.constraint ?? null), fallback, fallback + side * 0.3))
      samples.forEach((sample, index) => {
        if (sample.constraint === undefined) sample.point.z = filled[index]
        else sample.point.z = side > 0 ? Math.max(sample.constraint, filled[index]) : Math.min(sample.constraint, filled[index])
      })
      return samples.map((sample) => sample.point)
    })
    const region = side < 0 ? 'side-left' : 'side-right'
    addTracer(group, tracers, sideRows[3], 0xf3fbff, `${region}:row-3`, region)
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

const deltaHeatColor = (value: number) => {
  const yellow = new THREE.Color(0xffea2e)
  const orange = new THREE.Color(0xff4f0f)
  const magenta = new THREE.Color(0xff0a9d)
  return value < 0.58
    ? yellow.lerp(orange, value / 0.58)
    : orange.lerp(magenta, (value - 0.58) / 0.42)
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
    tracer.path.material.color.copy(tracer.baseColor)
    tracer.marker.material.color.copy(tracer.baseColor)
    tracer.path.material.opacity = tracer.pathBaseOpacity
    tracer.marker.material.opacity = tracer.markerBaseOpacity
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
      const color = deltaHeatColor(intensity)
      tracer.path.material.color.copy(color)
      tracer.marker.material.color.copy(color)
      tracer.path.material.opacity = 0.64 + intensity * 0.24
      tracer.marker.material.opacity = 0.9
    }
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
  rig.opacityMaterials.forEach((entry) => {
    entry.material.color.copy(baselineColor)
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
  rig.tracers.forEach(({ curve, marker, phase }, index) => {
    const progress = (phase + elapsed * flowRate * (0.9 + index * 0.018)) % 1
    marker.position.copy(curve.getPointAt(progress))
    marker.quaternion.setFromUnitVectors(markerUp, curve.getTangentAt(progress).normalize())
  })
}
