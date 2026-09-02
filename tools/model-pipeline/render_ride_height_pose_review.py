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
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--component-map", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--front-delta-mm", default=55.0, type=float)
    parser.add_argument("--rear-delta-mm", default=70.0, type=float)
    return parser.parse_args(script_args())


def web_to_blender(point: list[float]) -> Vector:
    x, y, z = point
    return Vector((x, -z, y))


def descendants(root: bpy.types.Object) -> set[bpy.types.Object]:
    result: set[bpy.types.Object] = set()
    pending = list(root.children)
    while pending:
        child = pending.pop()
        result.add(child)
        pending.extend(child.children)
    return result


def matrix_error(left: Matrix, right: Matrix) -> float:
    return max(abs(a - b) for left_row, right_row in zip(left, right) for a, b in zip(left_row, right_row))


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    component_map = json.loads(args.component_map.read_text(encoding="utf-8"))
    components = component_map["components"]
    args.output_dir.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    root = bpy.data.objects.get("car-root")
    sprung_chassis = bpy.data.objects.get("sprung-chassis")
    if root is None or sprung_chassis is None or sprung_chassis.parent != root:
        raise RuntimeError("The candidate does not contain a valid sprung-chassis hierarchy")

    link_nodes = {component["id"]: bpy.data.objects.get(component["id"]) for component in components}
    missing = sorted(name for name, node in link_nodes.items() if node is None)
    if missing:
        raise RuntimeError(f"Suspension nodes were not found: {', '.join(missing)}")
    wheel_nodes = {
        obj.name: obj
        for obj in root.children
        if obj.get("control") == "wheelRotation"
    }
    carrier_nodes = {
        obj.name: obj
        for obj in root.children
        if obj.get("control") == "cornerCarrier"
    }
    if len(wheel_nodes) != 4 or len(carrier_nodes) != 4:
        raise RuntimeError("Expected four wheel nodes and four corner carriers")

    sprung_meshes = {obj for obj in descendants(sprung_chassis) if obj.type == "MESH"}
    link_meshes = {
        obj
        for node in link_nodes.values()
        for obj in descendants(node)
        if obj.type == "MESH"
    }
    fixed_meshes = {
        obj
        for node in [*wheel_nodes.values(), *carrier_nodes.values()]
        for obj in descendants(node)
        if obj.type == "MESH"
    }
    if not sprung_meshes or not link_meshes or not fixed_meshes:
        raise RuntimeError("The pose review hierarchy has an empty mesh group")

    for obj in [item for item in bpy.context.scene.objects if item.type == "MESH"]:
        if obj in sprung_meshes:
            obj.color = (0.12, 0.62, 0.26, 1.0)
        elif obj in link_meshes:
            obj.color = (0.62, 0.24, 0.92, 1.0)
        elif obj in fixed_meshes:
            obj.color = (0.95, 0.42, 0.08, 1.0)
        else:
            obj.color = (0.26, 0.30, 0.34, 1.0)

    front_x = sum(
        web_to_blender(component["outerEndpointWeb"]).x
        for component in components
        if "-front-" in component["id"]
    ) / sum(1 for component in components if "-front-" in component["id"])
    rear_x = sum(
        web_to_blender(component["outerEndpointWeb"]).x
        for component in components
        if "-rear-" in component["id"]
    ) / sum(1 for component in components if "-rear-" in component["id"])
    midpoint_x = (front_x + rear_x) / 2
    chassis_rest = sprung_chassis.matrix_world.copy()
    link_rest = {
        component["id"]: {
            "outer": web_to_blender(component["outerEndpointWeb"]),
            "innerLocal": chassis_rest.inverted() @ web_to_blender(component["innerEndpointWeb"]),
            "restLength": float(component["restLengthM"]),
        }
        for component in components
    }
    fixed_baseline = {obj.name: obj.matrix_world.copy() for obj in fixed_meshes}

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
    scene.world = bpy.data.worlds.new("ride-height-review-world")
    scene.world.color = (0.025, 0.03, 0.04)

    camera_data = bpy.data.cameras.new("ride-height-review-camera")
    camera = bpy.data.objects.new("ride-height-review-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.lens = 58
    views = {
        "side": (Vector((0.0, -8.2, 2.0)), Vector((0.0, 0.0, 0.55))),
        "perspective": (Vector((-5.8, -6.2, 3.0)), Vector((0.0, 0.0, 0.55))),
    }

    maximum_endpoint_error = 0.0
    maximum_fixed_mesh_error = 0.0
    outputs = []
    pose_checks = {}

    def apply_pose(front_delta_mm: float, rear_delta_mm: float) -> dict[str, float | int]:
        nonlocal maximum_endpoint_error, maximum_fixed_mesh_error
        front_delta = front_delta_mm / 1000
        rear_delta = rear_delta_mm / 1000
        midpoint_delta = (front_delta + rear_delta) / 2
        pitch = -math.atan2(rear_delta - front_delta, rear_x - front_x)
        pose = (
            Matrix.Translation((0.0, 0.0, midpoint_delta))
            @ Matrix.Translation((midpoint_x, 0.0, 0.0))
            @ Matrix.Rotation(pitch, 4, "Y")
            @ Matrix.Translation((-midpoint_x, 0.0, 0.0))
        )
        sprung_chassis.matrix_world = pose @ chassis_rest
        bpy.context.view_layer.update()
        pose_endpoint_error = 0.0
        for component in components:
            node = link_nodes[component["id"]]
            rest = link_rest[component["id"]]
            outer = rest["outer"]
            inner = sprung_chassis.matrix_world @ rest["innerLocal"]
            direction = inner - outer
            node.location = outer
            node.rotation_mode = "QUATERNION"
            node.rotation_quaternion = direction.to_track_quat("X", "Z")
            node.scale = (direction.length / rest["restLength"], 1.0, 1.0)
            bpy.context.view_layer.update()
            actual_outer = node.matrix_world.translation
            actual_inner = node.matrix_world @ Vector((rest["restLength"], 0.0, 0.0))
            pose_endpoint_error = max(
                pose_endpoint_error,
                (actual_outer - outer).length,
                (actual_inner - inner).length,
            )
        fixed_error = max(
            matrix_error(obj.matrix_world, fixed_baseline[obj.name]) for obj in fixed_meshes
        )
        maximum_endpoint_error = max(maximum_endpoint_error, pose_endpoint_error)
        maximum_fixed_mesh_error = max(maximum_fixed_mesh_error, fixed_error)
        return {
            "frontDeltaMm": front_delta_mm,
            "rearDeltaMm": rear_delta_mm,
            "pitchDegrees": math.degrees(pitch),
            "maximumEndpointErrorM": pose_endpoint_error,
            "maximumFixedMeshMatrixError": fixed_error,
            "sprungMeshCount": len(sprung_meshes),
            "fixedMeshCount": len(fixed_meshes),
            "suspensionMeshCount": len(link_meshes),
        }

    poses = {
        "rest": (0.0, 0.0),
        "inspection-extreme": (args.front_delta_mm, args.rear_delta_mm),
    }
    for pose_name, deltas in poses.items():
        pose_checks[pose_name] = apply_pose(*deltas)
        for view_name, (position, target) in views.items():
            camera.location = position
            look_at(camera, target)
            output = (args.output_dir / f"rb22-ride-height-{pose_name}-{view_name}.png").resolve()
            scene.render.filepath = str(output)
            bpy.ops.render.render(write_still=True)
            outputs.append(str(output))

    if maximum_endpoint_error > 1e-4:
        raise RuntimeError(f"Suspension endpoint error is {maximum_endpoint_error:.6f} m")
    if maximum_fixed_mesh_error > 1e-6:
        raise RuntimeError(f"Wheel or carrier mesh moved by {maximum_fixed_mesh_error:.6g}")
    report = {
        "input": str(args.input.resolve()),
        "componentMap": str(args.component_map.resolve()),
        "outputs": outputs,
        "poseChecks": pose_checks,
        "maximumEndpointErrorM": maximum_endpoint_error,
        "maximumFixedMeshMatrixError": maximum_fixed_mesh_error,
        "passed": True,
        "rideHeightReady": False,
        "note": "Inspection deltas validate hierarchy and linkage only; they are not approved setup limits.",
    }
    (args.output_dir / "rb22-ride-height-pose-review.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
