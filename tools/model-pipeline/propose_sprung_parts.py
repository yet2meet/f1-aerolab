from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--wheel-map", required=True, type=Path)
    parser.add_argument("--source-object", default="Object_63")
    parser.add_argument("--wheel-clearance", default=0.65, type=float)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def distance(left: list[float], right: list[float]) -> float:
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right, strict=True)))


def main() -> None:
    args = parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    wheel_map = json.loads(args.wheel_map.read_text(encoding="utf-8"))
    wheel_centers = [component["pivotWeb"] for component in wheel_map["components"]]
    parts = [
        part for part in report["parts"] if part["sourceObject"] == args.source_object
    ]
    if not parts:
        raise RuntimeError(f"No parts found for {args.source_object}")

    sprung_parts = []
    unclassified_parts = []
    minimum_distances = {}
    for part in parts:
        minimum_distance = min(distance(part["center"], center) for center in wheel_centers)
        minimum_distances[part["id"]] = minimum_distance
        target = sprung_parts if minimum_distance > args.wheel_clearance else unclassified_parts
        target.append(part["id"])

    if set(sprung_parts) & set(unclassified_parts):
        raise RuntimeError("A part cannot be both sprung and unclassified")
    if set(sprung_parts) | set(unclassified_parts) != {part["id"] for part in parts}:
        raise RuntimeError("The source object classification is incomplete")

    output = {
        "schemaVersion": 1,
        "modelId": "rb22-sprung-parts-proposal",
        "sourceReport": str(args.report),
        "sourceObject": args.source_object,
        "rideHeightReady": False,
        "selection": {
            "method": "minimum 3D distance from reviewed wheel pivots",
            "wheelClearanceM": args.wheel_clearance,
            "wheelCenters": wheel_centers,
        },
        "sprungParts": sorted(sprung_parts),
        "unclassifiedParts": sorted(unclassified_parts),
        "checks": {
            "sourcePartCount": len(parts),
            "sprungPartCount": len(sprung_parts),
            "unclassifiedPartCount": len(unclassified_parts),
            "minimumSprungWheelDistanceM": min(
                minimum_distances[part_id] for part_id in sprung_parts
            ),
            "maximumUnclassifiedWheelDistanceM": max(
                minimum_distances[part_id] for part_id in unclassified_parts
            ),
            "complete": True,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
