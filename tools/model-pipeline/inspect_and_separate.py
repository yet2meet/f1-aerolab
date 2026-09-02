from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--blend-output", required=True, type=Path)
    parser.add_argument("--report-output", required=True, type=Path)
    return parser.parse_args(_script_args())


def _script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def mesh_objects() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return (
        Vector((min(point[i] for point in points) for i in range(3))),
        Vector((max(point[i] for point in points) for i in range(3))),
    )


def bake_web_orientation(objects: list[bpy.types.Object]) -> None:
    bounds_min, bounds_max = world_bounds(objects)
    size = bounds_max - bounds_min
    # Blender imports glTF's +Y-up coordinate system into Blender's +Z-up world.
    # Recreate the web viewer's final convention: car length on X (nose at -X),
    # height on +Y, and width on Z.
    if size.y > size.x:
        rotation = Matrix(
            (
                (0.0, 1.0, 0.0, 0.0),
                (0.0, 0.0, 1.0, 0.0),
                (1.0, 0.0, 0.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            )
        )
    else:
        rotation = Matrix(
            (
                (-1.0, 0.0, 0.0, 0.0),
                (0.0, 0.0, 1.0, 0.0),
                (0.0, 1.0, 0.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            )
        )

    rotated_points = [rotation @ (obj.matrix_world @ Vector(corner)) for obj in objects for corner in obj.bound_box]
    rotated_min = Vector((min(point[i] for point in rotated_points) for i in range(3)))
    rotated_max = Vector((max(point[i] for point in rotated_points) for i in range(3)))
    rotated_size = rotated_max - rotated_min
    scale = 6.35 / max(rotated_size.x, rotated_size.z)
    center = (rotated_min + rotated_max) * 0.5
    translation = Vector((-center.x * scale, -rotated_min.y * scale, -center.z * scale))

    for obj in objects:
        obj.data = obj.data.copy()
        transform = Matrix.Translation(translation) @ Matrix.Scale(scale, 4) @ rotation @ obj.matrix_world
        obj.data.transform(transform)
        obj.matrix_world = Matrix.Identity(4)


def separate_loose_parts(objects: list[bpy.types.Object]) -> None:
    for obj in objects:
        source_name = obj.name
        for candidate in bpy.context.selected_objects:
            candidate.select_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="LOOSE")
        bpy.ops.object.mode_set(mode="OBJECT")
        for separated in bpy.context.selected_objects:
            separated["source_object"] = source_name


def object_record(obj: bpy.types.Object) -> dict[str, object]:
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    bounds_min = Vector((min(point[i] for point in corners) for i in range(3)))
    bounds_max = Vector((max(point[i] for point in corners) for i in range(3)))
    size = bounds_max - bounds_min
    center = (bounds_min + bounds_max) * 0.5
    return {
        "id": obj.name,
        "sourceObject": obj.get("source_object", obj.name),
        "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
        "bounds": {"min": list(bounds_min), "max": list(bounds_max)},
        "center": list(center),
        "size": list(size),
        "vertices": len(obj.data.vertices),
        "triangles": sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons),
    }


def front_wing_score(record: dict[str, object], car_min_x: float, car_size_x: float, car_max_y: float) -> float:
    center = record["center"]
    size = record["size"]
    frontness = 1.0 - (center[0] - car_min_x) / max(car_size_x, 1e-6)
    lowness = 1.0 - center[1] / max(car_max_y, 1e-6)
    span = min(2.0, size[2] / max(size[0], size[1], 0.01))
    return frontness * 4.0 + lowness * 1.5 + span


def main() -> None:
    args = parse_args()
    args.blend_output.parent.mkdir(parents=True, exist_ok=True)
    args.report_output.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    imported = mesh_objects()
    if not imported:
        raise RuntimeError("The source GLB did not contain any mesh objects")

    bake_web_orientation(imported)
    separate_loose_parts(imported)
    parts = mesh_objects()
    parts.sort(key=lambda obj: tuple(round(value, 6) for value in object_record(obj)["center"]))
    for index, obj in enumerate(parts, start=1):
        obj.name = f"part-{index:04d}"

    records = [object_record(obj) for obj in parts]
    car_min_x = min(record["bounds"]["min"][0] for record in records)
    car_max_x = max(record["bounds"]["max"][0] for record in records)
    car_max_y = max(record["bounds"]["max"][1] for record in records)
    for record in records:
        record["frontWingCandidateScore"] = front_wing_score(
            record, car_min_x, car_max_x - car_min_x, car_max_y
        )

    candidates = [
        record["id"]
        for record in sorted(records, key=lambda item: item["frontWingCandidateScore"], reverse=True)
        if record["center"][0] < car_min_x + (car_max_x - car_min_x) * 0.22
        and record["center"][1] < car_max_y * 0.55
    ][:80]

    report = {
        "source": str(args.input.resolve()),
        "coordinateSystem": {"forward": "-X", "up": "+Y", "left": "+Z", "lengthMeters": 6.35},
        "partCount": len(records),
        "frontWingCandidates": candidates,
        "parts": records,
    }
    args.report_output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend_output.resolve()))


if __name__ == "__main__":
    main()
