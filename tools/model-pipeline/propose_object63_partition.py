from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--wheel-map", required=True, type=Path)
    parser.add_argument("--suspension-map", required=True, type=Path)
    parser.add_argument("--source-object", default="Object_63")
    parser.add_argument("--longitudinal-clearance", default=0.42, type=float)
    parser.add_argument("--lateral-clearance", default=0.48, type=float)
    parser.add_argument("--minimum-height", default=0.12, type=float)
    parser.add_argument("--maximum-height", default=0.86, type=float)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    wheel_map = json.loads(args.wheel_map.read_text(encoding="utf-8"))
    suspension_map = json.loads(args.suspension_map.read_text(encoding="utf-8"))
    wheel_centers = {
        component["id"]: component["pivotWeb"] for component in wheel_map["components"]
    }
    parts = {
        part["id"]: part
        for part in report["parts"]
        if part["sourceObject"] == args.source_object
    }
    if not parts:
        raise RuntimeError(f"No parts found for {args.source_object}")

    suspension_parts = {
        part_id
        for component in suspension_map["components"]
        for part_id in component["parts"]
    }
    missing_suspension_parts = sorted(suspension_parts - parts.keys())
    if missing_suspension_parts:
        raise RuntimeError(
            f"Suspension parts are missing from {args.source_object}: "
            f"{', '.join(missing_suspension_parts[:12])}"
        )

    sprung_parts = []
    unsprung_parts = []
    unsprung_parts_by_corner = {corner: [] for corner in wheel_centers}
    for part_id, part in parts.items():
        if part_id in suspension_parts:
            continue
        x, y, z = part["center"]
        nearby_corners = [
            (corner, center)
            for corner, center in wheel_centers.items()
            if abs(x - center[0]) <= args.longitudinal_clearance
            and abs(z - center[2]) <= args.lateral_clearance
            and args.minimum_height <= y <= args.maximum_height
        ]
        if not nearby_corners:
            sprung_parts.append(part_id)
            continue
        corner, _center = min(
            nearby_corners,
            key=lambda item: sum(
                (value - pivot) ** 2 for value, pivot in zip(part["center"], item[1])
            ),
        )
        unsprung_parts.append(part_id)
        unsprung_parts_by_corner[corner].append(part_id)

    classified = set(sprung_parts) | set(unsprung_parts) | suspension_parts
    if classified != set(parts):
        raise RuntimeError("The Object_63 partition is incomplete")
    if (
        set(sprung_parts) & set(unsprung_parts)
        or set(sprung_parts) & suspension_parts
        or set(unsprung_parts) & suspension_parts
    ):
        raise RuntimeError("Object_63 partition groups overlap")

    output = {
        "schemaVersion": 1,
        "modelId": "rb22-object63-partition-candidate",
        "sourceReport": str(args.report),
        "sourceObject": args.source_object,
        "selection": {
            "method": "explicit suspension links plus conservative wheel-corner boxes",
            "wheelCenters": wheel_centers,
            "longitudinalClearanceM": args.longitudinal_clearance,
            "lateralClearanceM": args.lateral_clearance,
            "minimumHeightM": args.minimum_height,
            "maximumHeightM": args.maximum_height,
        },
        "sprungParts": sorted(sprung_parts),
        "unsprungParts": sorted(unsprung_parts),
        "unsprungPartsByCorner": {
            corner: sorted(part_ids)
            for corner, part_ids in unsprung_parts_by_corner.items()
        },
        "suspensionParts": sorted(suspension_parts),
        "checks": {
            "sourcePartCount": len(parts),
            "sprungPartCount": len(sprung_parts),
            "unsprungPartCount": len(unsprung_parts),
            "unsprungPartCountByCorner": {
                corner: len(part_ids)
                for corner, part_ids in unsprung_parts_by_corner.items()
            },
            "suspensionPartCount": len(suspension_parts),
            "complete": True,
            "exclusive": True,
        },
        "rideHeightReady": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
