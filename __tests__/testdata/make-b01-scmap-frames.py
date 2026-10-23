"""Generate __tests__/testdata/b01_scmap_frames.json.

SCMap (B01/Q7 RobotMap) frames serialized with python-roborock 7.13.0's own
generated protobuf module, so the plugin's decoder is tested against bytes the
reference schema produces rather than against a hand-written encoder that
shares the decoder's assumptions.

Run:  python3 -I make-b01-scmap-frames.py /path/to/python-roborock/src out.json
      npx prettier --write out.json

The geometry copies the maintainer's sc05 "1. Sal" (pi-roborock.log, 21 Oct
2026): origin -14,-5 at 0.05 m/cell, outlines spanning 38-293 x 90-227. The
origin is deliberately asymmetric, so a decoder that mixes up x and y fails.
"""

import importlib.util
import json
import os
import sys

# Loaded by path: importing the `roborock` package would pull in its network
# dependencies, and only the generated schema module is needed here.
_spec = importlib.util.spec_from_file_location(
    "b01_scmap_pb2",
    os.path.join(sys.argv[1], "roborock", "map", "proto", "b01_scmap_pb2.py"),
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
RobotMap = _module.RobotMap

MIN_X, MIN_Y, RES = -14.0, -5.0, 0.05
SIZE_X, SIZE_Y = 300, 250
ROOMS = {
    10: ("Stue", (40, 140, 90, 200)),
    11: ("Gæsteværelse", (150, 290, 90, 227)),
}


def cell_to_world(cx, cy):
    return MIN_X + cx * RES, MIN_Y + cy * RES


def build(map_type, pose, with_map_type=True):
    m = RobotMap()
    if with_map_type:
        m.mapType = map_type
    h = m.mapHead
    h.mapHeadId = 1
    h.sizeX = SIZE_X
    h.sizeY = SIZE_Y
    h.minX = MIN_X
    h.minY = MIN_Y
    h.maxX = MIN_X + SIZE_X * RES
    h.maxY = MIN_Y + SIZE_Y * RES
    h.resolution = RES
    # A real frame carries the occupancy grid; a short one is enough to make
    # the decoder skip a large length-delimited field it does not read.
    m.mapData.mapData = bytes([127]) * 64
    m.chargeStation.x, m.chargeStation.y = cell_to_world(60, 100)
    if pose is not None:
        m.currentPose.poseId = 1
        m.currentPose.update = 1
        m.currentPose.x = pose[0]
        m.currentPose.y = pose[1]
        m.currentPose.phi = 0.5
    for room_id, (name, _) in ROOMS.items():
        r = m.roomDataInfo.add()
        r.roomId = room_id
        r.roomName = name
    for room_id, (_, (x0, x1, y0, y1)) in ROOMS.items():
        o = m.roomOutline.add()
        o.roomId = room_id
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            p = o.points.add()
            p.x, p.y, p.value = x, y, 1
    return m.SerializeToString().hex()


frames = {
    "description": "SCMap RobotMap frames serialized by python-roborock 7.13.0 b01_scmap_pb2; see make-b01-scmap-frames.py",
    "head": {"minX": MIN_X, "minY": MIN_Y, "resolution": RES, "sizeX": SIZE_X, "sizeY": SIZE_Y},
    "rooms": [{"roomId": k, "roomName": v[0]} for k, v in ROOMS.items()],
    # mapType 0: the live map the robot pushes while cleaning.
    "liveInStue": build(0, cell_to_world(100, 150)),
    "liveInGaest": build(0, cell_to_world(200, 210)),
    # Inside the map, outside both outlines (the doorway at x 140..150).
    "liveBetweenRooms": build(0, cell_to_world(145, 150)),
    # A live frame whose pose is the placeholder: no position, not a room.
    "livePlaceholder": build(0, (1100.0, 1100.0)),
    # mapType 1: a saved map, as service.upload_by_mapid returns it. Its pose
    # is the (1100, 1100) placeholder the field logged 226 times in a clean.
    "savedPlaceholder": build(1, (1100.0, 1100.0)),
    # A saved map whose pose happens to be inside the map: still not a live
    # position, because a saved map carries none.
    "savedInStue": build(1, cell_to_world(100, 150)),
}

with open(sys.argv[2], "w") as out:
    json.dump(frames, out, indent=1, ensure_ascii=False)
    out.write("\n")
