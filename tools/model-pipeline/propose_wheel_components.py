from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


WHEEL_SOURCE_OBJECTS = {
    "Object_467": "brake-disc",
    "Object_470": "wheel-hub",
    "Object_543": "tire-sidewall",
    "Object_546": "tire-tread",
}
WHEEL_IDS = (
    "wheel-front-left",
    "wheel-front-right",
    "wheel-rear-left",
    "wheel-rear-right",
)
EXPECTED_PART_COUNTS = {
    "Object_467": 3,
    "Object_543": 2,
    "Object_546": 1,
}
MAX_CENTER_DISTANCE_M = 0.45
MIN_ASSIGNMENT_GAP_M = 0.5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def center_distance(left: dict[str, object], right: dict[str, object]) -> float:
    return math.hypot(
        left["center"][0] - right["center"][0],
        left["center"][2] - right["center"][2],
    )


def main() -> None:
    args = parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    candidates = [
        part for part in report["parts"] if part["sourceObject"] in WHEEL_SOURCE_OBJECTS
    ]
    treads = [part for part in candidates if part["sourceObject"] == "Object_546"]
    treads.sort(key=lambda part: (round(part["center"][0], 1), -part["center"][2]))
    if len(treads) != len(WHEEL_IDS):
        raise RuntimeError(f"Expected four tire treads, found {len(treads)}")

    groups = [
        {"id": wheel_id, "center": tread["center"], "parts": []}
        for wheel_id, tread in zip(WHEEL_IDS, treads, strict=True)
    ]
    for part in candidates:
        ranked_wheels = sorted(
            ((center_distance(part, group), group) for group in groups),
            key=lambda item: item[0],
        )
        distance, wheel = ranked_wheels[0]
        assignment_gap = ranked_wheels[1][0] - distance
        if distance > MAX_CENTER_DISTANCE_M:
            raise RuntimeError(
                f"{part['id']} is {distance:.3f} m from its nearest wheel center"
            )
        if assignment_gap < MIN_ASSIGNMENT_GAP_M:
            raise RuntimeError(
                f"{part['id']} wheel assignment gap is only {assignment_gap:.3f} m"
            )
        wheel["parts"].append((part, assignment_gap))

    components = []
    group_checks = {}
    for wheel in groups:
        parts = [part for part, _assignment_gap in wheel["parts"]]
        counts = {
            source_object: sum(
                part["sourceObject"] == source_object for part in parts
            )
            for source_object in WHEEL_SOURCE_OBJECTS
        }
        for source_object, expected in EXPECTED_PART_COUNTS.items():
            if counts[source_object] != expected:
                raise RuntimeError(
                    f"{wheel['id']} expected {expected} {source_object} parts, "
                    f"found {counts[source_object]}"
                )
        max_distance = max(center_distance(part, wheel) for part in parts)
        min_assignment_gap = min(
            assignment_gap for _part, assignment_gap in wheel["parts"]
        )
        group_checks[wheel["id"]] = {
            "partCount": len(parts),
            "partsBySourceObject": counts,
            "maxCenterDistanceM": max_distance,
            "minAssignmentGapM": min_assignment_gap,
            "passed": (
                max_distance <= MAX_CENTER_DISTANCE_M
                and min_assignment_gap >= MIN_ASSIGNMENT_GAP_M
            ),
        }
        components.append(
            {
                "id": wheel["id"],
                "control": "wheelRotation",
                "parts": sorted(
                    (part["id"] for part in parts),
                    key=lambda part_id: int(part_id.split("-")[-1]),
                ),
                "hingeAxis": "+Z",
                "pivotWeb": wheel["center"],
            }
        )

    output = {
        "schemaVersion": 1,
        "modelId": "rb22-wheel-proposal",
        "source": report["source"],
        "sourceReport": str(args.report),
        "selection": {
            "sourceObjects": WHEEL_SOURCE_OBJECTS,
            "assignment": "nearest tire-tread center in the web X/Z plane",
            "maxCenterDistanceM": MAX_CENTER_DISTANCE_M,
            "minAssignmentGapM": MIN_ASSIGNMENT_GAP_M,
        },
        "components": components,
        "groupChecks": group_checks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
