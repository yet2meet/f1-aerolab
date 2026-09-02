from __future__ import annotations

import argparse
import colorsys
import json
from pathlib import Path

import bpy
from mathutils import Vector


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--component-map", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(script_args())


def web_to_blender(point: list[float]) -> Vector:
    x, y, z = point
    return Vector((x, -z, y))


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def descendants(root: bpy.types.Object) -> set[bpy.types.Object]:
    result: set[bpy.types.Object] = set()
    pending = list(root.children)
    while pending:
        child = pending.pop()
        result.add(child)
        pending.extend(child.children)
    return result


def main() -> None:
    args = parse_args()
    component_map = json.loads(args.component_map.read_text(encoding="utf-8"))
    components = component_map["components"]
    args.output_dir.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    nodes = {component["id"]: bpy.data.objects.get(component["id"]) for component in components}
    missing = sorted(name for name, node in nodes.items() if node is None)
    if missing:
        raise RuntimeError(f"Suspension nodes were not found: {', '.join(missing)}")

    mesh_axles: dict[bpy.types.Object, str] = {}
    for component in components:
        node = nodes[component["id"]]
        axle = component["id"].split("-")[1]
        for child in descendants(node):
            if child.type == "MESH":
                mesh_axles[child] = axle
    for obj in [item for item in bpy.context.scene.objects if item.type == "MESH"]:
        obj.hide_render = obj not in mesh_axles
        if obj in mesh_axles:
            link_index = int(obj.parent.name.rsplit("-", 1)[-1])
            hue = (link_index * 0.17 + (0.48 if mesh_axles[obj] == "front" else 0.04)) % 1.0
            red, green, blue = colorsys.hsv_to_rgb(hue, 0.75, 1.0)
            obj.color = (red, green, blue, 1.0)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    camera_data = bpy.data.cameras.new("suspension-articulation-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.25
    camera = bpy.data.objects.new("suspension-articulation-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    maximum_endpoint_error = 0.0

    def apply_pose(front_delta_mm: float, rear_delta_mm: float) -> None:
        nonlocal maximum_endpoint_error
        for component in components:
            node = nodes[component["id"]]
            axle = component["id"].split("-")[1]
            delta_m = (front_delta_mm if axle == "front" else rear_delta_mm) / 1000
            outer = web_to_blender(component["outerEndpointWeb"])
            inner = web_to_blender(component["innerEndpointWeb"]) + Vector((0.0, 0.0, delta_m))
            direction = inner - outer
            node.location = outer
            node.rotation_mode = "QUATERNION"
            node.rotation_quaternion = direction.to_track_quat("X", "Z")
            node.scale = (direction.length / float(component["restLengthM"]), 1.0, 1.0)
            bpy.context.view_layer.update()
            actual_outer = node.matrix_world.translation
            actual_inner = node.matrix_world @ Vector((float(component["restLengthM"]), 0.0, 0.0))
            maximum_endpoint_error = max(
                maximum_endpoint_error,
                (actual_outer - outer).length,
                (actual_inner - inner).length,
            )

    views = {
        "front": {
            "position": Vector((-4.6, -3.6, 1.8)),
            "target": Vector((-1.55, 0.1, 0.48)),
            "travel": (55.0, 0.0),
        },
        "rear": {
            "position": Vector((5.1, -3.6, 1.8)),
            "target": Vector((2.3, 0.1, 0.48)),
            "travel": (0.0, 70.0),
        },
    }
    outputs = []
    for axle, view in views.items():
        for mesh, mesh_axle in mesh_axles.items():
            mesh.hide_render = mesh_axle != axle
        camera.location = view["position"]
        look_at(camera, view["target"])
        for pose_name, deltas in (
            ("rest", (0.0, 0.0)),
            ("travel", view["travel"]),
        ):
            apply_pose(*deltas)
            output = (args.output_dir / f"rb22-suspension-{axle}-{pose_name}.png").resolve()
            scene.render.filepath = str(output)
            bpy.ops.render.render(write_still=True)
            outputs.append(str(output))

    if maximum_endpoint_error > 1e-4:
        raise RuntimeError(
            f"Suspension articulation endpoint error is {maximum_endpoint_error:.6f} m"
        )
    report = {
        "input": str(args.input.resolve()),
        "componentMap": str(args.component_map.resolve()),
        "outputs": outputs,
        "frontTravelDeltaMm": 55,
        "rearTravelDeltaMm": 70,
        "maximumEndpointErrorM": maximum_endpoint_error,
        "passed": True,
        "rideHeightReady": False,
    }
    (args.output_dir / "rb22-suspension-articulation-review.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
