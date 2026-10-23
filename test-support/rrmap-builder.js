"use strict";

/**
 * Classic RRMaps (what get_map_v1 returns once decrypted and gunzipped), laid
 * out as vacuum-map-parser-roborock 0.1.5 reads them: a 20-byte "rr" header,
 * then blocks of {type int16, header length int16, data length int32}. The
 * IMAGE block carries top/left/height/width as the last four int32 of its
 * header; ROBOT_POSITION carries x, y (mm) and, when longer than 8 bytes, an
 * angle. The reference parser reads these maps (see
 * __tests__/testdata/rrmap-room-by-reference.py).
 */

const crypto = require("crypto");

/** @param {{top: number, left: number, width: number, height: number, pixels: number[]}} image */
function imageBlock({ top, left, width, height, pixels }) {
  const header = Buffer.alloc(28);
  header.writeUInt16LE(2, 0);
  header.writeUInt16LE(28, 2);
  header.writeUInt32LE(pixels.length, 4);
  header.writeInt32LE(top, 12);
  header.writeInt32LE(left, 16);
  header.writeInt32LE(height, 20);
  header.writeInt32LE(width, 24);
  return Buffer.concat([header, Buffer.from(pixels)]);
}

/**
 * @param {number} x mm
 * @param {number} y mm
 * @param {{withAngle?: boolean}} [options] 12-byte block (x, y, angle) or
 *   the 8-byte one older firmware sends (x, y)
 */
function robotPositionBlock(x, y, { withAngle = true } = {}) {
  const length = withAngle ? 12 : 8;
  const block = Buffer.alloc(8 + length);
  block.writeUInt16LE(8, 0);
  block.writeUInt16LE(8, 2);
  block.writeUInt32LE(length, 4);
  block.writeInt32LE(x, 8);
  block.writeInt32LE(y, 12);
  if (withAngle) {
    block.writeInt32LE(90, 16);
  }
  return block;
}

/** @param {Buffer[]} blocks */
function rrMap(blocks) {
  const body = Buffer.concat(blocks);
  const header = Buffer.alloc(20);
  header[0] = 0x72;
  header[1] = 0x72;
  header.writeUInt16LE(20, 2);
  header.writeUInt32LE(20 + body.length, 4);
  header.writeUInt16LE(1, 8);
  header.writeUInt32LE(7, 12);
  header.writeUInt32LE(1, 16);
  const withoutDigest = Buffer.concat([header, body]);
  return Buffer.concat([
    withoutDigest,
    crypto.createHash("sha1").update(withoutDigest).digest(),
  ]);
}

/** Pixel value of floor in room `id` (vacuum-map-parser: low bits 7). */
const roomPixel = (id) => (id << 3) | 7;

module.exports = { imageBlock, robotPositionBlock, rrMap, roomPixel };
