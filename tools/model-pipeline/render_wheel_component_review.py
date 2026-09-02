from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


WHEEL_COLORS = {
    "wheel-front-left": (1.0, 0.22, 0.06, 1.0),
    "wheel-front-right": (0.08, 0.76, 1.0, 1.0),
    "wheel-rear-left": (0.72, 1.0, 0.12, 1.0),
    "wheel-rear-right": (0.92, 0.18, 1.0, 1.0),
}


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
    args.output_dir.mkdir(parents=True, exist_ok=True)
    wheel_map = json.loads(args.map.read_text(encoding="utf-8"))
    part_to_wheel = {
        part_id: component["id"]
        for component in wheel_map["components"]
        for part_id in component["parts"]
    }

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    missing = sorted(set(part_to_wheel) - {obj.name for obj in mesh_objects})
    if missing:
        raise RuntimeError(f"Mapped wheel parts are missing: {', '.join(missing[:12])}")
    for obj in mesh_objects:
        obj.matrix_world = Matrix.Rotation(math.pi / 2, 4, "X") @ obj.matrix_world
        wheel_id = part_to_wheel.get(obj.name)
        obj.color = WHEEL_COLORS.get(wheel_id, (0.055, 0.07, 0.08, 1.0))

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

    camera_data = bpy.data.cameras.new("wheel-review-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 7.5
    camera = bpy.data.objects.new("wheel-review-camera", camera_data)
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
    outputs = []
    for name, position in views.items():
        camera.location = position
        look_at(camera, target)
        output = (args.output_dir / f"rb22-wheels-{name}.png").resolve()
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        outputs.append(str(output))

    manifest = {
        "map": str(args.map.resolve()),
        "colors": WHEEL_COLORS,
        "outputs": outputs,
    }
    (args.output_dir / "rb22-wheels-review.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
