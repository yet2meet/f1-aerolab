# Semantic F1 model pipeline

This pipeline converts licensed source GLBs into Blender working files whose aerodynamic parts can be reviewed, named, assigned a hinge pivot, and exported as semantic GLB nodes.

## D-drive isolation

`run-blender.ps1` launches the portable Blender copy from `.tools/blender` and directs Blender user resources, extensions, scripts, temporary files, and its process-local AppData roots to the D-drive `portable` directory.

## First-pass topology report

```powershell
tools\model-pipeline\run-blender.ps1 --background --factory-startup --python tools\model-pipeline\inspect_and_separate.py -- --input public\models\rb22.glb --blend-output work\model-pipeline\rb22-separated.blend --report-output work\model-pipeline\rb22-parts.json
```

The generated candidate list is an offline review aid only. A candidate becomes an aerodynamic component only after visual confirmation and an explicit mapping. Runtime code must use semantic node names and must not infer parts from coordinates, materials, or generic source names.

## Visual review

```powershell
$argsForBlender = @(
  '--background',
  'work\model-pipeline\rb22-separated.blend',
  '--python',
  'tools\model-pipeline\render_part_review.py',
  '--',
  '--report',
  'work\model-pipeline\rb22-parts.json',
  '--output-dir',
  'work\model-pipeline\review',
  '--region',
  'front'
)
tools\model-pipeline\run-blender.ps1 -BlenderArgs $argsForBlender
```

The four whole-car views and isolated candidate views are generated under `work/model-pipeline/review`. The explicit, visually confirmed RB22 selection lives in `maps/rb22-component-map.json`.
Use `--region rear` to render the rear-wing candidates with `rb22-rear-*` output names.

## Wheel candidate review

Generate an explicit four-wheel proposal from the source model's dedicated tire,
hub and brake-disc objects. This proposal is not a runtime rig until all five
review views have been inspected:

```powershell
python tools\model-pipeline\propose_wheel_components.py --report work\model-pipeline\rb22-parts.json --output work\model-pipeline\rb22-wheel-proposal.json

$argsForBlender = @(
  '--background',
  'work\model-pipeline\rb22-separated.blend',
  '--python',
  'tools\model-pipeline\render_wheel_component_review.py',
  '--',
  '--map',
  'work\model-pipeline\rb22-wheel-proposal.json',
  '--output-dir',
  'work\model-pipeline\wheel-review'
)
tools\model-pipeline\run-blender.ps1 -BlenderArgs $argsForBlender
```

The generated colors identify front-left, front-right, rear-left and rear-right
wheel groups. Suspension and chassis parts remain static until they have their
own visually confirmed semantic mapping.

## Source-object review

Before assigning a mixed source mesh to a sprung or unsprung hierarchy, render
its loose parts in context. Repeat `--source-object` up to four times to compare
source groups with distinct colors:

```powershell
$argsForBlender = @(
  '--background',
  'work\model-pipeline\rb22-separated.blend',
  '--python',
  'tools\model-pipeline\render_source_object_review.py',
  '--',
  '--report',
  'work\model-pipeline\rb22-parts.json',
  '--source-object',
  'Object_63',
  '--output-dir',
  'work\model-pipeline\source-review'
)
tools\model-pipeline\run-blender.ps1 -BlenderArgs $argsForBlender
```

The reviewed candidate hierarchy is passed explicitly with `--sprung-map`.
The current RB22 candidate map keeps mixed `Object_63` geometry at `car-root`
and records `rideHeightReady: false`; it must not replace the runtime GLB:

```powershell
--sprung-map tools\model-pipeline\maps\rb22-sprung-candidate-map.json
```

For the mixed carbon source, generate a conservative distance proposal and
render it before writing any explicit loose-part mapping:

```powershell
python tools\model-pipeline\propose_sprung_parts.py --report work\model-pipeline\rb22-parts.json --wheel-map work\model-pipeline\rb22-wheel-proposal.json --source-object Object_63 --wheel-clearance 0.65 --output work\model-pipeline\rb22-sprung-parts-proposal.json

$argsForBlender = @(
  '--background',
  'work\model-pipeline\rb22-separated.blend',
  '--python',
  'tools\model-pipeline\render_sprung_parts_review.py',
  '--',
  '--map',
  'work\model-pipeline\rb22-sprung-parts-proposal.json',
  '--output-dir',
  'work\model-pipeline\sprung-parts-review'
)
tools\model-pipeline\run-blender.ps1 -BlenderArgs $argsForBlender
```

Green parts are conservative sprung candidates and orange parts remain
unclassified. The distance proposal is a visual review aid only: it splits
some multi-piece suspension links and therefore cannot enable ride height.

## Semantic rig export

```powershell
$argsForBlender = @(
  '--background',
  'work\model-pipeline\rb22-separated.blend',
  '--python',
  'tools\model-pipeline\rig_and_export.py',
  '--',
  '--map',
  'tools\model-pipeline\maps\rb22-component-map.json',
  '--extra-map',
  'work\model-pipeline\rb22-wheel-proposal.json',
  '--blend-output',
  'work\model-pipeline\rb22-rigged.blend',
  '--glb-output',
  'public\models\rb22-wheels-rigged.glb',
  '--report-output',
  'work\model-pipeline\rb22-rig-report.json'
)
tools\model-pipeline\run-blender.ps1 -BlenderArgs $argsForBlender
```

The exporter rejoins the thousands of static topology islands by their original source mesh, creates only the mapped semantic control nodes, and verifies that a test rotation changes only the expected component mesh before writing the GLB. The original `public/models/rb22.glb` is never overwritten.

Pass a visually reviewed secondary map with repeated `--extra-map` arguments.
For example, use `--extra-map work\model-pipeline\rb22-wheel-proposal.json`
to export the four reviewed wheel nodes alongside the aerodynamic components.

Reload the exported GLB in a clean Blender scene before wiring it into the viewer:

```powershell
$argsForBlender = @(
  '--background',
  '--factory-startup',
  '--python',
  'tools\model-pipeline\validate_semantic_glb.py',
  '--',
  '--input',
  'public\models\rb22-wheels-rigged.glb',
  '--map',
  'tools\model-pipeline\maps\rb22-component-map.json',
  '--extra-map',
  'work\model-pipeline\rb22-wheel-proposal.json',
  '--report-output',
  'work\model-pipeline\rb22-rigged-validation.json'
)
tools\model-pipeline\run-blender.ps1 -BlenderArgs $argsForBlender
```
