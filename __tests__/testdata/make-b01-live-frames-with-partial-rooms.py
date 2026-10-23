"""Generate __tests__/testdata/b01_live_frames_with_partial_rooms.json.

Two Q7 live-map frames (mapType 0) whose roomDataInfo is not the robot's full
named room list, serialized with python-roborock 7.13.0's own generated
protobuf module (as make-b01-scmap-frames.py does). Same geometry as
b01_scmap_frames.json: the robot stands in Stue (room 10).

Whether a real sc05 live frame lists every room, by name, has never been
seen; these are the two shapes that would hurt if a live frame were allowed
to rewrite the saved room list.

Run:  python3 -I make-b01-live-frames-with-partial-rooms.py /path/to/python-roborock/src out.json
      npx prettier --write out.json
"""

import importlib.util
import json
import os
import sys

_spec = importlib.util.spec_from_file_location(
    "b01_scmap_pb2",
    os.path.join(sys.argv[1], "roborock", "map", "proto", "b01_scmap_pb2.py"),
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
RobotMap = _module.RobotMap

MIN_X, MIN_Y, RES = -14.0, -5.0, 0.05
SIZE_X, SIZE_Y = 300, 250
LIVE_MAP_TYPE = 0


def world(cell_x, cell_y):
    return MIN_X + cell_x * RES, MIN_Y + cell_y * RES


def live_frame(pose, rooms):
    robot_map = RobotMap()
    robot_map.mapType = LIVE_MAP_TYPE
    head = robot_map.mapHead
    head.mapHeadId = 1
    head.sizeX = SIZE_X
    head.sizeY = SIZE_Y
    head.minX = MIN_X
    head.minY = MIN_Y
    head.maxX = MIN_X + SIZE_X * RES
    head.maxY = MIN_Y + SIZE_Y * RES
    head.resolution = RES
    robot_map.mapData.mapData = bytes([127]) * 64
    robot_map.currentPose.poseId = 1
    robot_map.currentPose.update = 1
    robot_map.currentPose.x, robot_map.currentPose.y = pose
    robot_map.currentPose.phi = 0.5
    for room_id, name in rooms:
        room = robot_map.roomDataInfo.add()
        room.roomId = room_id
        if name is not None:
            room.roomName = name
    outline = robot_map.roomOutline.add()
    outline.roomId = 10
    for x, y in ((40, 90), (140, 90), (140, 200), (40, 200)):
        point = outline.points.add()
        point.x, point.y, point.value = x, y, 1
    return robot_map.SerializeToString().hex()


frames = {
    # A room clean of Stue only, whose live frame names only Stue.
    "liveInStueOnlyStue": live_frame(world(100, 150), [(10, "Stue")]),
    # A live frame whose roomDataInfo carries ids without names.
    "liveInStueNoNames": live_frame(world(100, 150), [(10, None), (11, None)]),
}

with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump(frames, out, indent=2)
    out.write("\n")
