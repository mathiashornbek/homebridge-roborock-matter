"use strict";

// The RRMap block types the live-room lookup reads (vacuum-map-parser-roborock
// map_data_parser: block type int16 at 0, header length int16 at 2, data
// length int32 at 4).
const TYPES = {
  IMAGE: 2,
  ROBOT_POSITION: 8,
};

const OFFSETS = {
  HLENGTH: 0x02,
  LENGTH: 0x04,
};

/**
 * Classic (v1) RRMap reading. Only the live-room lookup below is used; the
 * full parser this module was forked with was never called and is gone.
 * The class remains because each vacuum runtime still constructs one.
 */
class RRMapParser {
  constructor(adapter) {
    this.adapter = adapter;
  }
}

/**
 * Fast path for live-room tracking: resolve the robot's segment DIRECTLY
 * from the raw RRMap buffer without materializing any pixel arrays.
 *
 * A full parse collects floor/obstacle/segment pixel lists (hundreds of
 * thousands of array entries on a real map — measured ~23 ms and ~6.7 MB of
 * allocations per parse on an 800x800 map), which live-room tracking would
 * pay every ~20 s only to look up a single pixel. This walk touches each
 * block header once, remembers where the IMAGE pixel data and the robot
 * position live, and reads exactly ONE pixel byte.
 *
 * The SHA1 tail check is intentionally skipped here: the transport layer
 * already gunzips the payload (gzip's CRC32 validates integrity), and the
 * header magic + block-structure walk reject malformed buffers.
 *
 * @param {Buffer} buf raw RRMap buffer (decrypted and gunzipped)
 * @returns {number | null} segment id, or null when position/geometry is
 *   missing, the robot is outside the image, or on an unsegmented pixel.
 */
RRMapParser.resolveLiveSegmentFromMapBuffer = function (buf) {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 0x18 ||
    buf[0x00] !== 0x72 ||
    buf[0x01] !== 0x72
  ) {
    return null;
  }

  const dataLength = buf.readUInt32LE(OFFSETS.LENGTH);
  const end = Math.min(dataLength, buf.length);

  let image = null;
  let position = null;

  let dataPosition = 0x14;
  while (dataPosition + 8 <= end) {
    const type = buf.readUInt16LE(dataPosition);
    const hlength = buf.readUInt16LE(dataPosition + OFFSETS.HLENGTH);
    const length = buf.readUInt32LE(dataPosition + OFFSETS.LENGTH);
    if (hlength < 8 || dataPosition + hlength + length > buf.length) {
      return null; // malformed block table
    }

    if (type === TYPES.IMAGE && hlength > 24) {
      const offset1 = buf.readUInt8(dataPosition + 2); // == hlength low byte
      image = {
        pixelsAt: dataPosition + offset1,
        top: buf.readInt32LE(dataPosition + offset1 - 0x10),
        left: buf.readInt32LE(dataPosition + offset1 - 0x0c),
        height: buf.readInt32LE(dataPosition + offset1 - 0x08),
        width: buf.readInt32LE(dataPosition + offset1 - 0x04),
        length,
      };
    } else if (type === TYPES.ROBOT_POSITION) {
      const offset1 = buf.readUInt8(dataPosition + 2);
      position = [
        buf.readInt32LE(dataPosition + offset1),
        buf.readInt32LE(dataPosition + (length >= 12 ? offset1 + 4 : offset1)),
      ];
    }

    dataPosition += hlength + length;
  }

  if (!image || !position || image.width <= 0 || image.height <= 0) {
    return null;
  }

  const pixelX = Math.floor(position[0] / 50) - image.left;
  const pixelY = Math.floor(position[1] / 50) - image.top;
  if (
    pixelX < 0 ||
    pixelY < 0 ||
    pixelX >= image.width ||
    pixelY >= image.height
  ) {
    return null;
  }

  const pixelIndex = pixelY * image.width + pixelX;
  if (pixelIndex >= image.length) {
    return null;
  }

  const pixelByte = buf.readUInt8(image.pixelsAt + pixelIndex);
  const pixelType = pixelByte & 0x07;
  if (pixelType === 0 || pixelType === 1) {
    return null; // outside the map or an obstacle pixel
  }
  const segmentId = (pixelByte & 248) >> 3;
  return segmentId !== 0 ? segmentId : null;
};

module.exports = RRMapParser;
