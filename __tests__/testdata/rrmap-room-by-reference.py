"""Print the room vacuum-map-parser-roborock 0.1.5 places the robot in, for
each RRMap given as a hex line on stdin (pip install
vacuum-map-parser-roborock==0.1.5). The expected rooms in
a-classic-live-room-reads-the-map-as-python-does.test.js are its answers for
the maps that test builds with test-support/rrmap-builder.js.
"""

import sys

from vacuum_map_parser_base.config.color import ColorsPalette
from vacuum_map_parser_base.config.image_config import ImageConfig
from vacuum_map_parser_base.config.size import Sizes
from vacuum_map_parser_roborock.map_data_parser import RoborockMapDataParser

parser = RoborockMapDataParser(ColorsPalette(), Sizes(), [], ImageConfig(), [])
for line in sys.stdin:
    line = line.strip()
    if line:
        print(parser.parse(bytes.fromhex(line)).vacuum_room)
