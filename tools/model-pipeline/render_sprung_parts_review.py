from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(script_args())


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    proposal = json.loads(args.map.read_text(encoding="utf-8"))
    sprung_parts = set(proposal["sprungParts"])
    unsprung_parts = set(
        proposal.get("unsprungParts", proposal.get("unclassifiedParts", []))
    )
    suspension_parts = set(proposal.get("suspensionParts", []))
    review_groups = (sprung_parts, unsprung_parts, suspension_parts)
    if any(left & right for index, left in enumerate(review_groups) for right in review_groups[index + 1 :]):
        raise RuntimeError("Sprung, unsprung, and suspension review parts overlap")

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    known_parts = {obj.name for obj in mesh_objects}
    missing = sorted((sprung_parts | unsprung_parts | suspension_parts) - known_parts)
    if missing:
        raise RuntimeError(f"Review parts are missing: {', '.join(missing[:12])}")

    rotation = Matrix.Rotation(math.pi / 2, 4, "X")
    for obj in mesh_objects:
        obj.matrix_world = rotation @ obj.matrix_world
        if obj.name in sprung_parts:
            obj.color = (0.12, 0.88, 0.42, 1.0)
        elif obj.name in unsprung_parts:
            obj.color = (1.0, 0.24, 0.05, 1.0)
        elif obj.name in suspension_parts:
            obj.color = (0.62, 0.24, 1.0, 1.0)
        else:
            obj.color = (0.035, 0.045, 0.05, 1.0)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    camera_data = bpy.data.cameras.new("sprung-review-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 7.5
    camera = bpy.data.objects.new("sprung-review-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    target = Vector((0.0, 0.0, 0.45))
    views = {
        "iso": Vector((-7.5, -7.0, 4.7)),
        "top": Vector((0.0, 0.0, 12.0)),
        "side": Vector((0.0, -12.0, 2.2)),
        "front": Vector((-12.0, 0.0, 1.4)),
        "rear": Vector((12.0, 0.0, 1.4)),
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for name, position in views.items():
        camera.location = position
        look_at(camera, target)
        output = (args.output_dir / f"rb22-sprung-parts-{name}.png").resolve()
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        outputs.append(str(output))

    scene.render.resolution_y = 1200
    camera_data.ortho_scale = 2.8
    detail_views = {
        "front-detail": (
            Vector((-6.0, 0.0, 1.0)),
            Vector((-1.71, 0.0, 0.44)),
        ),
        "rear-detail": (
            Vector((6.0, 0.0, 1.0)),
            Vector((2.37, 0.0, 0.44)),
        ),
    }
    for name, (position, detail_target) in detail_views.items():
        camera.location = position
        look_at(camera, detail_target)
        output = (args.output_dir / f"rb22-sprung-parts-{name}.png").resolve()
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        outputs.append(str(output))

    manifest = {
        "map": str(args.map.resolve()),
        "colors": {
            "sprungCandidate": (0.12, 0.88, 0.42, 1.0),
            "unsprungCandidate": (1.0, 0.24, 0.05, 1.0),
            "suspensionLink": (0.62, 0.24, 1.0, 1.0),
        },
        "outputs": outputs,
    }
    (args.output_dir / "rb22-sprung-parts-review.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
