from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proposal", required=True, type=Path)
    parser.add_argument("--selection-map", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    proposal = json.loads(args.proposal.read_text(encoding="utf-8"))
    selection = json.loads(args.selection_map.read_text(encoding="utf-8"))
    clusters = {cluster["id"]: cluster for cluster in proposal["clusters"]}
    components = []
    used_parts: set[str] = set()
    axle_indexes: dict[str, int] = {}
    selected_cluster_ids = [
        cluster_id
        for pair in selection["confirmedGeometryPairs"]
        for cluster_id in (pair["leftCluster"], pair["rightCluster"])
    ]
    classified_cluster_ids = selected_cluster_ids + selection["excludedFromLinkRig"]
    if len(classified_cluster_ids) != len(set(classified_cluster_ids)):
        raise RuntimeError("A suspension candidate is classified more than once")
    if set(classified_cluster_ids) != set(clusters):
        raise RuntimeError("The suspension selection does not classify every proposal cluster")

    centerline = float(selection["centerlineWebZ"])
    mirror_limit = float(selection["review"]["maximumAcceptedMirrorDeviationM"])
    maximum_mirror_deviation = 0.0

    for pair in selection["confirmedGeometryPairs"]:
        axle = pair["axle"]
        axle_indexes[axle] = axle_indexes.get(axle, 0) + 1
        pair_index = axle_indexes[axle]
        left_cluster = clusters[pair["leftCluster"]]
        right_cluster = clusters[pair["rightCluster"]]
        for key in ("centerWeb", "outerEndpointWeb", "innerEndpointWeb"):
            reflected_left = [
                left_cluster[key][0],
                left_cluster[key][1],
                2 * centerline - left_cluster[key][2],
            ]
            maximum_mirror_deviation = max(
                maximum_mirror_deviation,
                max(abs(left - right) for left, right in zip(reflected_left, right_cluster[key])),
            )
        for side, cluster_key in (
            ("left", "leftCluster"),
            ("right", "rightCluster"),
        ):
            cluster = clusters[pair[cluster_key]]
            expected_corner = f"wheel-{axle}-{side}"
            if cluster["corner"] != expected_corner:
                raise RuntimeError(
                    f"{cluster['id']} belongs to {cluster['corner']}, expected {expected_corner}"
                )
            duplicate_parts = used_parts.intersection(cluster["parts"])
            if duplicate_parts:
                raise RuntimeError(
                    f"Suspension parts are assigned more than once: {sorted(duplicate_parts)}"
                )
            used_parts.update(cluster["parts"])
            components.append(
                {
                    "id": f"suspension-{axle}-{side}-link-{pair_index:02d}",
                    "control": "suspensionLink",
                    "parts": cluster["parts"],
                    "hingeAxis": "free",
                    "pivotWeb": cluster["outerEndpointWeb"],
                    "outerEndpointWeb": cluster["outerEndpointWeb"],
                    "innerEndpointWeb": cluster["innerEndpointWeb"],
                    "restLengthM": cluster["lengthM"],
                    "sourceCandidate": cluster["id"],
                    "role": pair["role"],
                }
            )

    if maximum_mirror_deviation > mirror_limit:
        raise RuntimeError(
            f"Suspension mirror deviation {maximum_mirror_deviation:.4f} m exceeds "
            f"the {mirror_limit:.4f} m review limit"
        )

    output = {
        "schemaVersion": 1,
        "modelId": "rb22-suspension-components",
        "source": proposal["modelId"],
        "components": components,
        "selectedPartCount": len(used_parts),
        "maximumMirrorDeviationM": maximum_mirror_deviation,
        "rideHeightReady": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
