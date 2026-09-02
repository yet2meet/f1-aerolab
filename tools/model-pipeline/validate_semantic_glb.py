from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--extra-map", action="append", default=[], type=Path)
    parser.add_argument("--sprung-map", type=Path)
    parser.add_argument("--part-map", type=Path)
    parser.add_argument("--report-output", required=True, type=Path)
    return parser.parse_args(script_args())


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return (
        Vector((min(point[index] for point in points) for index in range(3))),
        Vector((max(point[index] for point in points) for index in range(3))),
    )


def matrix_values(matrix: Matrix) -> list[float]:
    return [value for row in matrix for value in row]


def matrices_close(left: Matrix, right: Matrix, tolerance: float = 1e-6) -> bool:
    return all(abs(a - b) <= tolerance for a, b in zip(matrix_values(left), matrix_values(right)))


def web_to_blender(point: list[float]) -> Vector:
    x, y, z = point
    return Vector((x, -z, y))


def safe_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def corner_suffix(corner: str) -> str:
    return safe_name(corner.removeprefix("wheel-"))


def source_parts_hash(part_ids: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(part_ids)).encode("utf-8")).hexdigest()


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
    component_maps = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in [args.map, *args.extra_map]
    ]
    components = [
        component
        for component_map in component_maps
        for component in component_map["components"]
    ]
    required_nodes = [component["id"] for component in components]
    wheel_node_names = {
        component["id"] for component in components if component["control"] == "wheelRotation"
    }
    suspension_node_names = {
        component["id"] for component in components if component["control"] == "suspensionLink"
    }
    if len(required_nodes) != len(set(required_nodes)):
        raise RuntimeError("A semantic component id is declared more than once")
    sprung_map = (
        json.loads(args.sprung_map.read_text(encoding="utf-8"))
        if args.sprung_map
        else None
    )
    part_map = (
        json.loads(args.part_map.read_text(encoding="utf-8")) if args.part_map else None
    )
    part_map_unsprung_by_corner = (
        {
            corner: list(part_ids)
            for corner, part_ids in part_map["unsprungPartsByCorner"].items()
        }
        if part_map
        else {}
    )
    if part_map:
        flattened_corner_parts = [
            part_id
            for part_ids in part_map_unsprung_by_corner.values()
            for part_id in part_ids
        ]
        if set(part_map_unsprung_by_corner) != wheel_node_names:
            raise RuntimeError("Part-map unsprung corners do not match wheel components")
        if any(not part_ids for part_ids in part_map_unsprung_by_corner.values()):
            raise RuntimeError("Every part-map unsprung corner must contain parts")
        if (
            set(flattened_corner_parts) != set(part_map["unsprungParts"])
            or len(flattened_corner_parts) != len(set(flattened_corner_parts))
        ):
            raise RuntimeError("Part-map unsprung corner groups are not exact and disjoint")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("The exported GLB did not contain any meshes")
    meshes_by_name = {obj.name: obj for obj in meshes}

    roots = [obj for obj in bpy.context.scene.objects if obj.name == "car-root"]
    if len(roots) != 1:
        raise RuntimeError(f"Expected one car-root node, found {len(roots)}")
    nodes: dict[str, bpy.types.Object] = {}
    for node_name in required_nodes:
        matches = [obj for obj in bpy.context.scene.objects if obj.name == node_name]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one {node_name} node, found {len(matches)}")
        nodes[node_name] = matches[0]
    corner_carriers: dict[str, bpy.types.Object] = {}
    for corner in sorted(part_map_unsprung_by_corner):
        carrier_name = f"corner-carrier-{corner_suffix(corner)}"
        matches = [obj for obj in bpy.context.scene.objects if obj.name == carrier_name]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one {carrier_name} node, found {len(matches)}")
        corner_carriers[corner] = matches[0]

    sprung_chassis = None
    hierarchy_checks = None
    if sprung_map and not wheel_node_names:
        raise RuntimeError("A sprung candidate requires explicit wheel components")
    if sprung_map:
        matches = [obj for obj in bpy.context.scene.objects if obj.name == "sprung-chassis"]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one sprung-chassis node, found {len(matches)}")
        sprung_chassis = matches[0]
        wheel_parent_ok = all(nodes[name].parent == roots[0] for name in wheel_node_names)
        suspension_parent_ok = all(
            nodes[name].parent == roots[0] for name in suspension_node_names
        )
        body_parent_ok = all(
            node.parent == sprung_chassis
            for name, node in nodes.items()
            if name not in wheel_node_names | suspension_node_names
        )
        sprung_static_ok = all(
            f"static-{safe_name(source_name)}" in meshes_by_name
            and meshes_by_name[f"static-{safe_name(source_name)}"].parent == sprung_chassis
            for source_name in sprung_map["sprungSourceObjects"]
            if not part_map or source_name != part_map["sourceObject"]
        )
        unclassified_static_ok = all(
            f"static-{safe_name(source_name)}" in meshes_by_name
            and meshes_by_name[f"static-{safe_name(source_name)}"].parent == roots[0]
            for source_name in sprung_map["unclassifiedSourceObjects"]
            if not part_map or source_name != part_map["sourceObject"]
        )
        part_map_hierarchy_ok = True
        corner_carrier_checks = {}
        if part_map:
            part_base_name = f"static-{safe_name(part_map['sourceObject'])}"
            sprung_part_mesh_ok = (
                f"{part_base_name}-sprung" in meshes_by_name
                and meshes_by_name[f"{part_base_name}-sprung"].parent == sprung_chassis
            )
            for corner, part_ids in sorted(part_map_unsprung_by_corner.items()):
                carrier = corner_carriers[corner]
                mesh_name = f"{part_base_name}-unsprung-{corner_suffix(corner)}"
                mesh = meshes_by_name.get(mesh_name)
                expected_hash = source_parts_hash(part_ids)
                pivot_error = (
                    carrier.matrix_world.translation
                    - nodes[corner].matrix_world.translation
                ).length
                mesh_ok = (
                    mesh is not None
                    and mesh.parent == carrier
                    and int(mesh.get("source_part_count", -1)) == len(part_ids)
                    and mesh.get("source_parts_sha256") == expected_hash
                )
                corner_carrier_checks[corner] = {
                    "node": carrier.name,
                    "parentIsRoot": carrier.parent == roots[0],
                    "controlMetadataPassed": carrier.get("control") == "cornerCarrier",
                    "cornerMetadataPassed": carrier.get("corner") == corner,
                    "wheelPivotErrorM": pivot_error,
                    "wheelPivotPassed": pivot_error <= 1e-4,
                    "mesh": mesh_name,
                    "meshPartsPassed": mesh_ok,
                    "passed": (
                        carrier.parent == roots[0]
                        and carrier.get("control") == "cornerCarrier"
                        and carrier.get("corner") == corner
                        and pivot_error <= 1e-4
                        and mesh_ok
                    ),
                }
            part_map_hierarchy_ok = sprung_part_mesh_ok and all(
                check["passed"] for check in corner_carrier_checks.values()
            )
        hierarchy_checks = {
            "sprungParentIsRoot": sprung_chassis.parent == roots[0],
            "wheelParentsAreRoot": wheel_parent_ok,
            "suspensionParentsAreRoot": suspension_parent_ok,
            "aeroParentsAreSprung": body_parent_ok,
            "sprungStaticParentsAreSprung": sprung_static_ok,
            "unclassifiedStaticParentsAreRoot": unclassified_static_ok,
            "partMapParentsAreCorrect": part_map_hierarchy_ok,
            "cornerCarriers": corner_carrier_checks,
            "rideHeightReady": sprung_map["rideHeightReady"],
        }
        if not all(
            value
            for key, value in hierarchy_checks.items()
            if key not in {"rideHeightReady", "cornerCarriers"}
        ):
            raise RuntimeError("Reloaded semantic hierarchy is invalid")

    bounds_min, bounds_max = world_bounds(meshes)
    size = bounds_max - bounds_min
    if not 6.0 <= size.x <= 6.7:
        raise RuntimeError(f"Unexpected car length after GLB reload: {size.x:.3f} m")
    if not 2.1 <= size.y <= 2.6 or not 1.2 <= size.z <= 1.6:
        raise RuntimeError(f"Unexpected width/height after GLB reload: {size.y:.3f} x {size.z:.3f} m")
    pivot_checks: dict[str, dict[str, object]] = {}
    suspension_endpoint_checks: dict[str, dict[str, object]] = {}
    for component in components:
        node = nodes[component["id"]]
        expected = web_to_blender(component["pivotWeb"])
        actual = node.matrix_world.translation.copy()
        distance = (actual - expected).length
        pivot_checks[component["id"]] = {
            "expectedBlender": list(expected),
            "actualBlender": list(actual),
            "distance": distance,
            "passed": distance <= 1e-4,
        }
        if distance > 1e-4:
            raise RuntimeError(
                f"{component['id']} pivot mismatch after GLB reload: "
                f"expected {tuple(round(value, 5) for value in expected)}, "
                f"actual {tuple(round(value, 5) for value in actual)}"
            )
        if component["id"] in suspension_node_names:
            expected_direction = (
                web_to_blender(component["innerEndpointWeb"])
                - web_to_blender(component["outerEndpointWeb"])
            ).normalized()
            actual_direction = (
                node.matrix_world.to_3x3() @ Vector((1.0, 0.0, 0.0))
            ).normalized()
            alignment = actual_direction.dot(expected_direction)
            exported_outer = list(node.get("outer_endpoint_web", []))
            exported_inner = list(node.get("inner_endpoint_web", []))
            endpoint_metadata_error = math.inf
            if len(exported_outer) == 3 and len(exported_inner) == 3:
                endpoint_metadata_error = max(
                    *(abs(actual - expected) for actual, expected in zip(exported_outer, component["outerEndpointWeb"])),
                    *(abs(actual - expected) for actual, expected in zip(exported_inner, component["innerEndpointWeb"])),
                )
            metadata_ok = (
                node.get("control") == "suspensionLink"
                and node.get("source_candidate") == component["sourceCandidate"]
                and abs(float(node.get("rest_length_m", math.inf)) - component["restLengthM"]) <= 1e-6
                and endpoint_metadata_error <= 1e-6
            )
            suspension_endpoint_checks[component["id"]] = {
                "directionAlignment": alignment,
                "parentIsRoot": node.parent == roots[0],
                "metadataPassed": metadata_ok,
                "endpointMetadataErrorM": endpoint_metadata_error,
                "passed": alignment >= 0.9999 and node.parent == roots[0] and metadata_ok,
            }
            if not suspension_endpoint_checks[component["id"]]["passed"]:
                raise RuntimeError(
                    f"{component['id']} suspension rest orientation is invalid"
                )

    baseline = {obj.name: obj.matrix_world.copy() for obj in meshes}
    isolation_checks: dict[str, dict[str, object]] = {}
    isolation_nodes = {
        **nodes,
        **{carrier.name: carrier for carrier in corner_carriers.values()},
    }
    for node_name, node in isolation_nodes.items():
        expected_changed = sorted(obj.name for obj in descendants(node) if obj.type == "MESH")
        rest_basis = node.matrix_basis.copy()
        node.matrix_basis = rest_basis @ Matrix.Rotation(math.radians(7.0), 4, "Y")
        bpy.context.view_layer.update()
        actual_changed = sorted(
            obj.name for obj in meshes if not matrices_close(obj.matrix_world, baseline[obj.name])
        )
        isolation_checks[node_name] = {
            "expectedChangedMeshes": expected_changed,
            "actualChangedMeshes": actual_changed,
            "passed": actual_changed == expected_changed,
        }
        node.matrix_basis = rest_basis
        bpy.context.view_layer.update()

    failed = [name for name, check in isolation_checks.items() if not check["passed"]]
    if failed:
        raise RuntimeError(f"Reloaded component isolation failed: {', '.join(failed)}")

    sprung_chassis_check = None
    if sprung_chassis:
        expected_changed = sorted(
            obj.name for obj in descendants(sprung_chassis) if obj.type == "MESH"
        )
        sprung_chassis.rotation_mode = "XYZ"
        sprung_chassis.rotation_euler.y += math.radians(7.0)
        bpy.context.view_layer.update()
        actual_changed = sorted(
            obj.name for obj in meshes if not matrices_close(obj.matrix_world, baseline[obj.name])
        )
        sprung_chassis_check = {
            "expectedChangedMeshes": expected_changed,
            "actualChangedMeshes": actual_changed,
            "passed": actual_changed == expected_changed,
            "rideHeightReady": False,
        }
        sprung_chassis.rotation_euler.y -= math.radians(7.0)
        bpy.context.view_layer.update()
        if not sprung_chassis_check["passed"]:
            raise RuntimeError("Reloaded sprung chassis isolation failed")

    report = {
        "input": str(args.input.resolve()),
        "componentMaps": [str(path.resolve()) for path in [args.map, *args.extra_map]],
        "meshCount": len(meshes),
        "rootNode": roots[0].name,
        "sprungChassisNode": sprung_chassis.name if sprung_chassis else None,
        "hierarchyChecks": hierarchy_checks,
        "sprungChassisCheck": sprung_chassis_check,
        "sprungMap": str(args.sprung_map.resolve()) if args.sprung_map else None,
        "partMap": str(args.part_map.resolve()) if args.part_map else None,
        "rideHeightReady": sprung_map["rideHeightReady"] if sprung_map else False,
        "semanticNodes": sorted(nodes),
        "suspensionLinkNodes": sorted(suspension_node_names),
        "cornerCarrierNodes": {
            corner: carrier.name for corner, carrier in sorted(corner_carriers.items())
        },
        "pivotChecks": pivot_checks,
        "suspensionEndpointChecks": suspension_endpoint_checks,
        "boundsBlender": {
            "min": list(bounds_min),
            "max": list(bounds_max),
            "size": list(size),
        },
        "isolationChecks": isolation_checks,
        "passed": True,
    }
    args.report_output.parent.mkdir(parents=True, exist_ok=True)
    args.report_output.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
