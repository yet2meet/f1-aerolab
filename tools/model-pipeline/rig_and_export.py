from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--extra-map", action="append", default=[], type=Path)
    parser.add_argument("--sprung-map", type=Path)
    parser.add_argument("--part-map", type=Path)
    parser.add_argument("--blend-output", required=True, type=Path)
    parser.add_argument("--glb-output", required=True, type=Path)
    parser.add_argument("--report-output", required=True, type=Path)
    return parser.parse_args(script_args())


def mesh_objects() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def select_only(objects: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def join_objects(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    if not objects:
        raise ValueError(f"Cannot create {name}: no source objects were supplied")
    if len(objects) == 1:
        joined = objects[0]
    else:
        select_only(objects)
        bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
    joined.name = name
    joined.data.name = f"{name}-geometry"
    return joined


def safe_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def corner_suffix(corner: str) -> str:
    return safe_name(corner.removeprefix("wheel-"))


def source_parts_hash(part_ids: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(part_ids)).encode("utf-8")).hexdigest()


def parent_preserving_world(child: bpy.types.Object, parent: bpy.types.Object) -> None:
    bpy.context.view_layer.update()
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = world
    bpy.context.view_layer.update()


def web_to_blender(point: list[float]) -> Vector:
    x, y, z = point
    return Vector((x, -z, y))


def matrix_values(matrix: Matrix) -> list[float]:
    return [value for row in matrix for value in row]


def matrices_close(left: Matrix, right: Matrix, tolerance: float = 1e-6) -> bool:
    return all(abs(a - b) <= tolerance for a, b in zip(matrix_values(left), matrix_values(right)))


def main() -> None:
    args = parse_args()
    component_maps = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in [args.map, *args.extra_map]
    ]
    components = [
        component
        for component_map in component_maps
        for component in component_map["components"]
    ]
    component_ids = [component["id"] for component in components]
    if len(component_ids) != len(set(component_ids)):
        raise RuntimeError("A semantic component id is declared more than once")
    wheel_component_ids = {
        component["id"] for component in components if component["control"] == "wheelRotation"
    }
    suspension_component_ids = {
        component["id"] for component in components if component["control"] == "suspensionLink"
    }
    sprung_map = (
        json.loads(args.sprung_map.read_text(encoding="utf-8"))
        if args.sprung_map
        else None
    )
    part_map = (
        json.loads(args.part_map.read_text(encoding="utf-8")) if args.part_map else None
    )
    parts_by_name = {obj.name: obj for obj in mesh_objects()}
    mapped_part_ids = [part_id for component in components for part_id in component["parts"]]
    missing = sorted(set(mapped_part_ids) - parts_by_name.keys())
    if missing:
        raise RuntimeError(f"Mapped parts were not found: {', '.join(missing)}")
    if len(mapped_part_ids) != len(set(mapped_part_ids)):
        raise RuntimeError("A source part is assigned to more than one semantic component")

    part_map_source = part_map["sourceObject"] if part_map else None
    part_map_sprung = set(part_map["sprungParts"]) if part_map else set()
    part_map_unsprung = set(part_map["unsprungParts"]) if part_map else set()
    part_map_suspension = set(part_map["suspensionParts"]) if part_map else set()
    part_map_unsprung_by_corner = (
        {
            corner: set(part_ids)
            for corner, part_ids in part_map["unsprungPartsByCorner"].items()
        }
        if part_map
        else {}
    )
    unsprung_corner_by_part = {
        part_id: corner
        for corner, part_ids in part_map_unsprung_by_corner.items()
        for part_id in part_ids
    }
    if part_map:
        source_parts = {
            part_id
            for part_id, obj in parts_by_name.items()
            if obj.get("source_object") == part_map_source
        }
        classified_parts = part_map_sprung | part_map_unsprung | part_map_suspension
        if classified_parts != source_parts:
            raise RuntimeError("The part map does not classify every source-object part")
        if (
            part_map_sprung & part_map_unsprung
            or part_map_sprung & part_map_suspension
            or part_map_unsprung & part_map_suspension
        ):
            raise RuntimeError("Part-map groups overlap")
        if set(part_map_unsprung_by_corner) != wheel_component_ids:
            raise RuntimeError("Part-map unsprung corners do not match wheel components")
        if any(not part_ids for part_ids in part_map_unsprung_by_corner.values()):
            raise RuntimeError("Every part-map unsprung corner must contain parts")
        corner_part_count = sum(
            len(part_ids) for part_ids in part_map_unsprung_by_corner.values()
        )
        if (
            set(unsprung_corner_by_part) != part_map_unsprung
            or corner_part_count != len(part_map_unsprung)
        ):
            raise RuntimeError("Part-map unsprung corner groups are not exact and disjoint")
        mapped_source_parts = set(mapped_part_ids) & source_parts
        if mapped_source_parts != part_map_suspension:
            raise RuntimeError("Part-map suspension parts do not match semantic components")

    original_mesh_count = len(parts_by_name)
    web_to_blender_rotation = Matrix.Rotation(math.pi / 2, 4, "X")
    for obj in parts_by_name.values():
        obj.matrix_world = web_to_blender_rotation @ obj.matrix_world
    bpy.context.view_layer.update()

    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)

    component_meshes: dict[str, bpy.types.Object] = {}
    for component in components:
        source_objects = [parts_by_name[part_id] for part_id in component["parts"]]
        component_meshes[component["id"]] = join_objects(
            source_objects,
            f"{component['id']}-mesh",
        )

    mapped_parts = set(mapped_part_ids)
    static_groups: dict[tuple[str, str, str | None], list[bpy.types.Object]] = defaultdict(list)
    for part_id, obj in parts_by_name.items():
        if part_id not in mapped_parts:
            source_name = str(obj.get("source_object", "unclassified"))
            role = "source"
            corner = None
            if part_map and source_name == part_map_source:
                role = "sprung" if part_id in part_map_sprung else "unsprung"
                if role == "unsprung":
                    corner = unsprung_corner_by_part[part_id]
            static_groups[(source_name, role, corner)].append(obj)

    static_meshes: list[bpy.types.Object] = []
    static_mesh_sources: dict[str, str] = {}
    static_mesh_roles: dict[str, str] = {}
    static_mesh_corners: dict[str, str | None] = {}
    static_mesh_part_ids: dict[str, list[str]] = {}
    used_names: set[str] = set()
    for (source_name, role, corner), objects in sorted(
        static_groups.items(), key=lambda item: tuple(value or "" for value in item[0])
    ):
        base_name = f"static-{safe_name(source_name) or 'unclassified'}"
        if role != "source":
            base_name = f"{base_name}-{role}"
        if corner:
            base_name = f"{base_name}-{corner_suffix(corner)}"
        name = base_name
        suffix = 2
        while name in used_names:
            name = f"{base_name}-{suffix}"
            suffix += 1
        used_names.add(name)
        part_ids = [obj.name for obj in objects]
        static_mesh = join_objects(objects, name)
        static_mesh["source_part_count"] = len(part_ids)
        static_mesh["source_parts_sha256"] = source_parts_hash(part_ids)
        static_meshes.append(static_mesh)
        static_mesh_sources[static_mesh.name] = source_name
        static_mesh_roles[static_mesh.name] = role
        static_mesh_corners[static_mesh.name] = corner
        static_mesh_part_ids[static_mesh.name] = sorted(part_ids)
    for component in components:
        if component["id"] not in suspension_component_ids:
            continue
        missing_fields = sorted(
            {"outerEndpointWeb", "innerEndpointWeb", "restLengthM", "sourceCandidate"}
            - component.keys()
        )
        if missing_fields:
            raise RuntimeError(
                f"{component['id']} is missing suspension fields: {', '.join(missing_fields)}"
            )
    root = bpy.data.objects.new("car-root", None)
    bpy.context.scene.collection.objects.link(root)
    corner_carriers: dict[str, bpy.types.Object] = {}
    if part_map:
        components_by_id = {component["id"]: component for component in components}
        for corner in sorted(part_map_unsprung_by_corner):
            carrier = bpy.data.objects.new(
                f"corner-carrier-{corner_suffix(corner)}", None
            )
            bpy.context.scene.collection.objects.link(carrier)
            carrier.location = web_to_blender(components_by_id[corner]["pivotWeb"])
            carrier["control"] = "cornerCarrier"
            carrier["corner"] = corner
            bpy.context.view_layer.update()
            parent_preserving_world(carrier, root)
            corner_carriers[corner] = carrier
    if sprung_map and not wheel_component_ids:
        raise RuntimeError("A sprung candidate requires explicit wheel components")
    sprung_source_objects = set(sprung_map["sprungSourceObjects"]) if sprung_map else set()
    unclassified_source_objects = (
        set(sprung_map["unclassifiedSourceObjects"]) if sprung_map else set()
    )
    if sprung_source_objects & unclassified_source_objects:
        raise RuntimeError("A source object cannot be both sprung and unclassified")
    declared_sources = sprung_source_objects | unclassified_source_objects
    static_source_names = {source_name for source_name, _role, _corner in static_groups}
    if sprung_map and declared_sources != static_source_names:
        missing = sorted(static_source_names - declared_sources)
        unknown = sorted(declared_sources - static_source_names)
        raise RuntimeError(
            f"Sprung source classification mismatch; missing={missing}, unknown={unknown}"
        )
    sprung_chassis = None
    if sprung_map:
        sprung_chassis = bpy.data.objects.new("sprung-chassis", None)
        bpy.context.scene.collection.objects.link(sprung_chassis)
        parent_preserving_world(sprung_chassis, root)
    for obj in static_meshes:
        source_name = static_mesh_sources[obj.name]
        role = static_mesh_roles[obj.name]
        if part_map and source_name == part_map_source:
            parent = (
                sprung_chassis
                if role == "sprung"
                else corner_carriers[static_mesh_corners[obj.name]]
            )
        else:
            parent = sprung_chassis if source_name in sprung_source_objects else root
        parent_preserving_world(obj, parent)

    component_nodes: dict[str, bpy.types.Object] = {}
    for component in components:
        node = bpy.data.objects.new(component["id"], None)
        bpy.context.scene.collection.objects.link(node)
        node.location = web_to_blender(component["pivotWeb"])
        node["control"] = component["control"]
        node["hinge_axis_web"] = component["hingeAxis"]
        if component["id"] in suspension_component_ids:
            outer = web_to_blender(component["outerEndpointWeb"])
            inner = web_to_blender(component["innerEndpointWeb"])
            direction = inner - outer
            if direction.length <= 1e-6:
                raise RuntimeError(f"{component['id']} has coincident suspension endpoints")
            node.location = outer
            node.rotation_mode = "QUATERNION"
            node.rotation_quaternion = direction.to_track_quat("X", "Z")
            node["outer_endpoint_web"] = component["outerEndpointWeb"]
            node["inner_endpoint_web"] = component["innerEndpointWeb"]
            node["rest_length_m"] = float(component["restLengthM"])
            node["source_candidate"] = component["sourceCandidate"]
        # Blender's depsgraph does not immediately reflect a freshly assigned
        # location in matrix_world. Update before preserving the node's world
        # transform, otherwise the pivot is captured as the origin and runtime
        # rotations swing the component around the whole-car origin.
        bpy.context.view_layer.update()
        component_parent = (
            root
            if component["id"] in wheel_component_ids | suspension_component_ids
            else sprung_chassis or root
        )
        parent_preserving_world(node, component_parent)
        parent_preserving_world(component_meshes[component["id"]], node)
        component_nodes[component["id"]] = node

    bpy.context.view_layer.update()
    exported_meshes = static_meshes + list(component_meshes.values())
    pivot_checks: dict[str, dict[str, object]] = {}
    for component_id, node in component_nodes.items():
        component = next(item for item in components if item["id"] == component_id)
        expected = web_to_blender(component["pivotWeb"])
        actual = node.matrix_world.translation.copy()
        distance = (actual - expected).length
        pivot_checks[component_id] = {
            "expectedBlender": list(expected),
            "actualBlender": list(actual),
            "distance": distance,
            "passed": distance <= 1e-4,
        }
        if distance > 1e-4:
            raise RuntimeError(
                f"{component_id} pivot mismatch before export: "
                f"expected {tuple(round(value, 5) for value in expected)}, "
                f"actual {tuple(round(value, 5) for value in actual)}"
            )
    baseline = {obj.name: obj.matrix_world.copy() for obj in exported_meshes}
    isolation_checks: dict[str, dict[str, object]] = {}
    for component_id, node in component_nodes.items():
        rest_basis = node.matrix_basis.copy()
        node.matrix_basis = rest_basis @ Matrix.Rotation(math.radians(7.0), 4, "Y")
        bpy.context.view_layer.update()
        changed = sorted(
            obj.name
            for obj in exported_meshes
            if not matrices_close(obj.matrix_world, baseline[obj.name])
        )
        expected = [component_meshes[component_id].name]
        isolation_checks[component_id] = {
            "expectedChangedMeshes": expected,
            "actualChangedMeshes": changed,
            "passed": changed == expected,
        }
        node.matrix_basis = rest_basis
        bpy.context.view_layer.update()
        if not all(matrices_close(obj.matrix_world, baseline[obj.name]) for obj in exported_meshes):
            raise RuntimeError(f"Failed to restore the baseline after testing {component_id}")

    failed_checks = [component_id for component_id, check in isolation_checks.items() if not check["passed"]]
    if failed_checks:
        raise RuntimeError(f"Component isolation failed: {', '.join(failed_checks)}")

    carrier_isolation_checks: dict[str, dict[str, object]] = {}
    for corner, carrier in corner_carriers.items():
        rest_basis = carrier.matrix_basis.copy()
        carrier.matrix_basis = rest_basis @ Matrix.Rotation(math.radians(7.0), 4, "Y")
        bpy.context.view_layer.update()
        changed = sorted(
            obj.name
            for obj in exported_meshes
            if not matrices_close(obj.matrix_world, baseline[obj.name])
        )
        expected = sorted(
            obj.name for obj in carrier.children_recursive if obj.type == "MESH"
        )
        carrier_isolation_checks[corner] = {
            "carrierNode": carrier.name,
            "expectedChangedMeshes": expected,
            "actualChangedMeshes": changed,
            "passed": changed == expected,
        }
        carrier.matrix_basis = rest_basis
        bpy.context.view_layer.update()
        if not all(
            matrices_close(obj.matrix_world, baseline[obj.name]) for obj in exported_meshes
        ):
            raise RuntimeError(f"Failed to restore the baseline after testing {carrier.name}")
    failed_carriers = [
        corner for corner, check in carrier_isolation_checks.items() if not check["passed"]
    ]
    if failed_carriers:
        raise RuntimeError(f"Corner carrier isolation failed: {', '.join(failed_carriers)}")

    sprung_chassis_check = None
    if sprung_chassis:
        expected_changed = sorted(
            obj.name for obj in sprung_chassis.children_recursive if obj.type == "MESH"
        )
        sprung_chassis.rotation_euler.rotate_axis("Y", math.radians(7.0))
        bpy.context.view_layer.update()
        actual_changed = sorted(
            obj.name
            for obj in exported_meshes
            if not matrices_close(obj.matrix_world, baseline[obj.name])
        )
        sprung_chassis_check = {
            "expectedChangedMeshes": expected_changed,
            "actualChangedMeshes": actual_changed,
            "passed": actual_changed == expected_changed,
            "rideHeightReady": False,
        }
        sprung_chassis.rotation_euler.rotate_axis("Y", math.radians(-7.0))
        bpy.context.view_layer.update()
        if not sprung_chassis_check["passed"]:
            raise RuntimeError("Sprung chassis isolation failed before export")

    args.blend_output.parent.mkdir(parents=True, exist_ok=True)
    args.glb_output.parent.mkdir(parents=True, exist_ok=True)
    args.report_output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend_output.resolve()))
    bpy.ops.export_scene.gltf(
        filepath=str(args.glb_output.resolve()),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
    )

    report = {
        "modelId": component_maps[0]["modelId"],
        "componentMaps": [str(path.resolve()) for path in [args.map, *args.extra_map]],
        "sourcePartCount": original_mesh_count,
        "exportedMeshCount": len(exported_meshes),
        "staticMeshCount": len(static_meshes),
        "semanticNodes": sorted(component_nodes),
        "suspensionLinkNodes": sorted(suspension_component_ids),
        "cornerCarrierNodes": {
            corner: carrier.name for corner, carrier in sorted(corner_carriers.items())
        },
        "cornerCarrierIsolationChecks": carrier_isolation_checks,
        "staticMeshParts": {
            name: {
                "sourcePartCount": len(part_ids),
                "sourcePartsSha256": source_parts_hash(part_ids),
            }
            for name, part_ids in sorted(static_mesh_part_ids.items())
        },
        "sprungChassisNode": sprung_chassis.name if sprung_chassis else None,
        "sprungChassisCheck": sprung_chassis_check,
        "sprungMap": str(args.sprung_map.resolve()) if args.sprung_map else None,
        "partMap": str(args.part_map.resolve()) if args.part_map else None,
        "rideHeightReady": sprung_map["rideHeightReady"] if sprung_map else False,
        "componentMeshes": {
            component_id: component_meshes[component_id].name for component_id in sorted(component_meshes)
        },
        "pivotChecks": pivot_checks,
        "isolationChecks": isolation_checks,
        "outputs": {
            "blend": str(args.blend_output.resolve()),
            "glb": str(args.glb_output.resolve()),
        },
    }
    args.report_output.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
