from __future__ import annotations

import argparse
import colorsys
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
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--selection-map", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args(script_args())


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def web_to_blender(point: list[float]) -> Vector:
    x, y, z = point
    return Vector((x, -z, y))


def cluster_color(index: int) -> tuple[float, float, float, float]:
    red, green, blue = colorsys.hsv_to_rgb((index * 0.61803398875) % 1.0, 0.82, 1.0)
    return red, green, blue, 1.0


def main() -> None:
    args = parse_args()
    proposal = json.loads(args.map.read_text(encoding="utf-8"))
    selected_cluster_ids = None
    if args.selection_map:
        selection = json.loads(args.selection_map.read_text(encoding="utf-8"))
        selected_cluster_ids = {
            cluster_id
            for pair in selection["confirmedGeometryPairs"]
            for cluster_id in (pair["leftCluster"], pair["rightCluster"])
        }
    clusters_by_corner: dict[str, list[dict[str, object]]] = {}
    for cluster in proposal["clusters"]:
        if selected_cluster_ids is not None and cluster["id"] not in selected_cluster_ids:
            continue
        clusters_by_corner.setdefault(cluster["corner"], []).append(cluster)

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    mesh_by_name = {obj.name: obj for obj in mesh_objects}
    rotation = Matrix.Rotation(math.pi / 2, 4, "X")
    for obj in mesh_objects:
        obj.matrix_world = rotation @ obj.matrix_world
        obj.color = (0.025, 0.032, 0.036, 1.0)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.render.resolution_x = 1800
    scene.render.resolution_y = 1300
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    camera_data = bpy.data.cameras.new("suspension-review-camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.65
    camera = bpy.data.objects.new("suspension-review-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    views = {
        "front-left": (
            "wheel-front-left",
            Vector((-5.4, -4.4, 2.0)),
            Vector((-1.66, -0.55, 0.44)),
        ),
        "front-left-outboard": (
            "wheel-front-left",
            Vector((-1.66, -4.8, 0.72)),
            Vector((-1.66, -0.55, 0.44)),
        ),
        "front-left-top": (
            "wheel-front-left",
            Vector((-1.66, -0.55, 4.8)),
            Vector((-1.66, -0.55, 0.44)),
        ),
        "front-left-front": (
            "wheel-front-left",
            Vector((-5.8, -0.55, 0.72)),
            Vector((-1.66, -0.55, 0.44)),
        ),
        "rear-left": (
            "wheel-rear-left",
            Vector((5.8, -4.4, 2.0)),
            Vector((2.37, -0.55, 0.44)),
        ),
        "rear-left-outboard": (
            "wheel-rear-left",
            Vector((2.37, -4.8, 0.72)),
            Vector((2.37, -0.55, 0.44)),
        ),
        "rear-left-top": (
            "wheel-rear-left",
            Vector((2.37, -0.55, 4.8)),
            Vector((2.37, -0.55, 0.44)),
        ),
        "rear-left-rear": (
            "wheel-rear-left",
            Vector((6.2, -0.55, 0.72)),
            Vector((2.37, -0.55, 0.44)),
        ),
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    legends = {}
    for view_name, (corner, position, target) in views.items():
        clusters = clusters_by_corner[corner]
        colored_parts = set()
        labels = []
        legend = []
        for index, cluster in enumerate(clusters):
            color = cluster_color(index)
            for part_id in cluster["parts"]:
                mesh_by_name[part_id].color = color
                colored_parts.add(part_id)
            label_data = bpy.data.curves.new(f"label-{cluster['id']}", "FONT")
            label_data.body = cluster["id"].rsplit("-", 1)[-1]
            label_data.align_x = "CENTER"
            label_data.size = 0.065
            label = bpy.data.objects.new(f"label-{cluster['id']}", label_data)
            label.location = web_to_blender(cluster["centerWeb"]) + Vector((0.0, 0.0, 0.035))
            label.color = color
            scene.collection.objects.link(label)
            labels.append(label)
            legend.append(
                {
                    "id": cluster["id"],
                    "color": color,
                    "parts": cluster["parts"],
                    "centerWeb": cluster["centerWeb"],
                    "lengthM": cluster["lengthM"],
                }
            )
        for obj in mesh_objects:
            obj.hide_render = obj.name not in colored_parts
        camera.location = position
        look_at(camera, target)
        for label in labels:
            label.rotation_euler = camera.rotation_euler
        output = (args.output_dir / f"rb22-suspension-{view_name}.png").resolve()
        scene.render.filepath = str(output)
        bpy.ops.render.render(write_still=True)
        outputs.append(str(output))
        legends[corner] = legend
        for label in labels:
            bpy.data.objects.remove(label, do_unlink=True)
        for obj in mesh_objects:
            obj.hide_render = False

    manifest = {
        "map": str(args.map.resolve()),
        "selectionMap": str(args.selection_map.resolve()) if args.selection_map else None,
        "outputs": outputs,
        "legends": legends,
    }
    (args.output_dir / "rb22-suspension-review.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
