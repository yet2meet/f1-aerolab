from __future__ import annotations

import argparse
import math
from pathlib import Path

import bpy
from mathutils import Vector


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(script_args())


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))

    mainplane = bpy.data.objects.get("front-wing-mainplane")
    flap = bpy.data.objects.get("front-wing-flap")
    rear_mainplane = bpy.data.objects.get("rear-wing-mainplane")
    rear_flap = bpy.data.objects.get("rear-wing-flap")
    if any(node is None for node in (mainplane, flap, rear_mainplane, rear_flap)):
        raise RuntimeError("The semantic front- and rear-wing nodes were not found")

    for obj in [candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"]:
        if obj.parent == mainplane:
            obj.color = (1.0, 0.18, 0.08, 1.0)
        elif obj.parent == flap:
            obj.color = (0.1, 0.75, 1.0, 1.0)
        elif obj.parent == rear_mainplane:
            obj.color = (1.0, 0.56, 0.08, 1.0)
        elif obj.parent == rear_flap:
            obj.color = (0.72, 1.0, 0.12, 1.0)
        else:
            obj.color = (0.075, 0.09, 0.10, 1.0)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    camera_data = bpy.data.cameras.new("rig-review-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 7.5
    camera = bpy.data.objects.new("rig-review-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.location = Vector((-7.1, -6.2, 3.7))
    look_at(camera, Vector((-0.5, 0.0, 0.65)))

    scene.render.filepath = str((args.output_dir / "rb22-rig-baseline.png").resolve())
    bpy.ops.render.render(write_still=True)

    mainplane.rotation_mode = "XYZ"
    flap.rotation_mode = "XYZ"
    mainplane.rotation_euler.y = math.radians(7.0)
    flap.rotation_euler.y = math.radians(12.0)
    bpy.context.view_layer.update()
    scene.render.filepath = str((args.output_dir / "rb22-rig-adjusted.png").resolve())
    bpy.ops.render.render(write_still=True)

    mainplane.rotation_euler.y = 0.0
    flap.rotation_euler.y = 0.0
    rear_mainplane.rotation_mode = "XYZ"
    rear_flap.rotation_mode = "XYZ"
    camera_data.ortho_scale = 2.3
    camera.location = Vector((5.2, -3.1, 2.25))
    look_at(camera, Vector((2.72, 0.12, 1.0)))
    bpy.context.view_layer.update()
    scene.render.filepath = str((args.output_dir / "rb22-rear-rig-baseline.png").resolve())
    bpy.ops.render.render(write_still=True)

    rear_mainplane.rotation_euler.y = math.radians(7.0)
    rear_flap.rotation_euler.y = math.radians(-12.0)
    bpy.context.view_layer.update()
    scene.render.filepath = str((args.output_dir / "rb22-rear-rig-adjusted.png").resolve())
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
