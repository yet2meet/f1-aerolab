from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


PALETTE = [
    (1.00, 0.18, 0.08, 1.0),
    (0.10, 0.75, 1.00, 1.0),
    (0.72, 1.00, 0.12, 1.0),
    (1.00, 0.72, 0.08, 1.0),
    (0.86, 0.18, 1.00, 1.0),
    (0.10, 1.00, 0.66, 1.0),
]


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--region", choices=("front", "rear"), default="front")
    return parser.parse_args(script_args())


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = json.loads(args.report.read_text(encoding="utf-8"))
    parts = {part["id"]: part for part in report["parts"]}

    if args.region == "rear":
        region_parts = [
            part
            for part in report["parts"]
            if part["center"][0] > 2.3
            and part["center"][1] > 0.75
            and part["size"][2] > 0.8
        ]
        is_near_region = lambda part: part["center"][0] > 2.3 and part["center"][1] > 0.65
        output_prefix = "rb22-rear"
        detail_target = Vector((2.72, 0.12, 1.0))
        detail_camera = Vector((5.2, -3.1, 2.25))
    else:
        region_parts = [
            part
            for part in report["parts"]
            if part["center"][0] < -2.35
            and part["center"][1] < 0.65
            and part["size"][2] > 0.9
        ]
        is_near_region = lambda part: part["center"][0] < -2.35 and part["center"][1] < 0.75
        output_prefix = "rb22"
        detail_target = Vector((-2.82, 0.12, 0.28))
        detail_camera = Vector((-4.7, -3.1, 1.65))

    region_parts.sort(key=lambda part: part["center"][0])
    highlighted = {part["id"]: PALETTE[index % len(PALETTE)] for index, part in enumerate(region_parts)}

    mesh_objects = [candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"]
    for obj in mesh_objects:
        obj.matrix_world = Matrix.Rotation(math.pi / 2, 4, "X") @ obj.matrix_world
        part = parts.get(obj.name)
        if obj.name in highlighted:
            obj.color = highlighted[obj.name]
        elif part and is_near_region(part):
            obj.color = (0.85, 0.30, 0.08, 1.0)
        else:
            obj.color = (0.075, 0.09, 0.10, 1.0)

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
    scene.render.film_transparent = False

    camera_data = bpy.data.cameras.new("review-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 8.0
    camera = bpy.data.objects.new("review-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    target = Vector((0.0, 0.0, 0.45))

    views = {
        "iso": Vector((-7.5, -7.0, 4.7)),
        "top": Vector((0.0, 0.0, 12.0)),
        "side": Vector((0.0, -12.0, 2.2)),
        "front": Vector((-12.0, 0.0, 1.4)),
    }
    for name, position in views.items():
        camera.location = position
        look_at(camera, target)
        scene.render.filepath = str((args.output_dir / f"{output_prefix}-{name}.png").resolve())
        bpy.ops.render.render(write_still=True)

    scene.render.resolution_x = 900
    scene.render.resolution_y = 700
    camera_data.ortho_scale = 2.7
    camera.location = detail_camera
    look_at(camera, detail_target)
    for part in region_parts:
        for obj in mesh_objects:
            if obj.name == part["id"]:
                obj.hide_render = False
                obj.color = highlighted[obj.name]
            elif obj.name in highlighted:
                obj.hide_render = True
        scene.render.filepath = str((args.output_dir / f"{output_prefix}-{part['id']}.png").resolve())
        bpy.ops.render.render(write_still=True)

    manifest = {
        "highlighted": [
            {
                "id": part["id"],
                "color": highlighted[part["id"]],
                "center": part["center"],
                "size": part["size"],
                "sourceObject": part["sourceObject"],
                "materials": part["materials"],
            }
            for part in region_parts
        ]
    }
    (args.output_dir / f"{output_prefix}-review-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
