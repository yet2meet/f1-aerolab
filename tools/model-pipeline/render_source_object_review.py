from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


HIGHLIGHT_COLORS = (
    (1.0, 0.20, 0.05, 1.0),
    (0.05, 0.78, 1.0, 1.0),
    (0.65, 1.0, 0.10, 1.0),
    (0.92, 0.15, 1.0, 1.0),
)


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--source-object", action="append", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(script_args())


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    if len(args.source_object) > len(HIGHLIGHT_COLORS):
        raise RuntimeError(f"At most {len(HIGHLIGHT_COLORS)} source objects can be reviewed")

    report = json.loads(args.report.read_text(encoding="utf-8"))
    source_colors = dict(zip(args.source_object, HIGHLIGHT_COLORS, strict=False))
    part_source = {part["id"]: part["sourceObject"] for part in report["parts"]}
    selected_parts = {
        part_id for part_id, source_object in part_source.items() if source_object in source_colors
    }
    missing_sources = sorted(set(args.source_object) - set(part_source.values()))
    if missing_sources:
        raise RuntimeError(f"Source objects are missing: {', '.join(missing_sources)}")

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    missing_parts = sorted(selected_parts - {obj.name for obj in mesh_objects})
    if missing_parts:
        raise RuntimeError(f"Source parts are missing: {', '.join(missing_parts[:12])}")

    web_to_blender_rotation = Matrix.Rotation(math.pi / 2, 4, "X")
    for obj in mesh_objects:
        obj.matrix_world = web_to_blender_rotation @ obj.matrix_world
        source_object = part_source.get(obj.name)
        obj.color = source_colors.get(source_object, (0.035, 0.045, 0.05, 1.0))

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

    camera_data = bpy.data.cameras.new("source-review-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 7.5
    camera = bpy.data.objects.new("source-review-camera", camera_data)
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
    output_paths = []
    for name, position in views.items():
        camera.location = position
        look_at(camera, target)
        output = (args.output_dir / f"rb22-source-{name}.png").resolve()
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        output_paths.append(str(output))

    manifest = {
        "report": str(args.report.resolve()),
        "sources": {
            source_object: {
                "color": color,
                "partCount": sum(value == source_object for value in part_source.values()),
            }
            for source_object, color in source_colors.items()
        },
        "outputs": output_paths,
    }
    (args.output_dir / "rb22-source-review.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
