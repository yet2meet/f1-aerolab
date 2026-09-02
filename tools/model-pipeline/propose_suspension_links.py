from __future__ import annotations

import argparse
import json
from pathlib import Path

import bpy
import numpy as np


def script_args() -> list[str]:
    import sys

    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel-map", required=True, type=Path)
    parser.add_argument("--source-object", default="Object_63")
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(script_args())


def geometry_record(objects: list[bpy.types.Object]) -> dict[str, object]:
    points = np.concatenate(
        [
            np.array([obj.matrix_world @ vertex.co for vertex in obj.data.vertices])
            for obj in objects
        ]
    )
    center = points.mean(axis=0)
    covariance = np.cov(points - center, rowvar=False)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    order = np.argsort(eigenvalues)[::-1]
    axes = eigenvectors[:, order]
    projections = (points - center) @ axes
    minimum = projections.min(axis=0)
    maximum = projections.max(axis=0)
    extents = maximum - minimum
    primary_axis = axes[:, 0]
    endpoints = [
        center + primary_axis * minimum[0],
        center + primary_axis * maximum[0],
    ]
    return {
        "center": center,
        "axis": primary_axis,
        "endpoints": endpoints,
        "extents": extents,
        "length": float(extents[0]),
        "aspect": float(extents[0] / max(extents[1], 0.002)),
    }


def main() -> None:
    args = parse_args()
    wheel_map = json.loads(args.wheel_map.read_text(encoding="utf-8"))
    wheel_centers = {
        component["id"]: np.array(component["pivotWeb"], dtype=float)
        for component in wheel_map["components"]
    }
    objects = [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.get("source_object") == args.source_object
    ]
    candidates = []
    for obj in objects:
        record = geometry_record([obj])
        center = record["center"]
        corner = min(
            wheel_centers,
            key=lambda wheel_id: np.linalg.norm(
                center[[0, 2]] - wheel_centers[wheel_id][[0, 2]]
            ),
        )
        wheel_center = wheel_centers[corner]
        if abs(center[0] - wheel_center[0]) > 0.85:
            continue
        if not 0.14 <= center[1] <= 0.85:
            continue
        if not 0.18 <= record["length"] <= 1.1 or record["aspect"] < 3.0:
            continue
        candidates.append({"id": obj.name, "corner": corner, **record})

    adjacency = {candidate["id"]: set() for candidate in candidates}
    for index, left in enumerate(candidates):
        for right in candidates[index + 1 :]:
            if left["corner"] != right["corner"]:
                continue
            direction_alignment = abs(float(np.dot(left["axis"], right["axis"])))
            if direction_alignment < 0.96:
                continue
            axis = left["axis"]
            if float(np.dot(axis, right["axis"])) < 0:
                axis = -axis
            delta = right["center"] - left["center"]
            perpendicular_distance = float(np.linalg.norm(delta - axis * np.dot(delta, axis)))
            endpoint_gap = min(
                float(np.linalg.norm(left_endpoint - right_endpoint))
                for left_endpoint in left["endpoints"]
                for right_endpoint in right["endpoints"]
            )
            if perpendicular_distance <= 0.075 and endpoint_gap <= 0.12:
                adjacency[left["id"]].add(right["id"])
                adjacency[right["id"]].add(left["id"])

    candidates_by_id = {candidate["id"]: candidate for candidate in candidates}
    objects_by_id = {obj.name: obj for obj in objects}
    remaining = set(adjacency)
    clusters = []
    while remaining:
        seed = remaining.pop()
        pending = [seed]
        part_ids = {seed}
        while pending:
            part_id = pending.pop()
            neighbors = adjacency[part_id] & remaining
            remaining -= neighbors
            part_ids |= neighbors
            pending.extend(neighbors)
        cluster_geometry = geometry_record([objects_by_id[part_id] for part_id in part_ids])
        if cluster_geometry["length"] < 0.25 or cluster_geometry["aspect"] < 2.8:
            continue
        corner = candidates_by_id[seed]["corner"]
        wheel_center = wheel_centers[corner]
        endpoints = cluster_geometry["endpoints"]
        outer_index = int(
            np.argmin([np.linalg.norm(endpoint - wheel_center) for endpoint in endpoints])
        )
        clusters.append(
            {
                "corner": corner,
                "parts": sorted(part_ids),
                "centerWeb": cluster_geometry["center"].tolist(),
                "axisWeb": cluster_geometry["axis"].tolist(),
                "lengthM": cluster_geometry["length"],
                "aspect": cluster_geometry["aspect"],
                "outerEndpointWeb": endpoints[outer_index].tolist(),
                "innerEndpointWeb": endpoints[1 - outer_index].tolist(),
            }
        )

    clusters.sort(key=lambda cluster: (cluster["corner"], cluster["centerWeb"][1]))
    for index, cluster in enumerate(clusters, start=1):
        cluster["id"] = f"suspension-link-candidate-{index:02d}"

    output = {
        "schemaVersion": 1,
        "modelId": "rb22-suspension-link-proposal",
        "sourceObject": args.source_object,
        "selection": {
            "method": "PCA slender-part detection and collinear endpoint clustering",
            "minimumDirectionAlignment": 0.96,
            "maximumPerpendicularDistanceM": 0.075,
            "maximumEndpointGapM": 0.12,
        },
        "candidatePartCount": len(candidates),
        "clusterCount": len(clusters),
        "clusters": clusters,
        "rideHeightReady": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
