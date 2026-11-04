import zlib from 'node:zlib'

/**
 * 测试用极简 PNG 编码器（8bit RGBA，filter=None）。
 * 只为在集成测试里造出与 Canvas 产物同格式（直通 alpha）的 PNG 帧，
 * 不用于生产路径（生产帧由渲染层 convertToBlob 产生）。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]!) & 0xff]!
  return (crc ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 生成一帧：全透明底 + 半透明红块 + 不透明蓝条，用于 alpha 与色彩断言。 */
export function rgbaFrame(
  width: number,
  height: number,
  painter: (x: number, y: number, index: number) => [number, number, number, number] | null
): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = painter(x, y, y * width + x)
      if (!pixel) continue
      const offset = (y * width + x) * 4
      buffer[offset] = pixel[0]
      buffer[offset + 1] = pixel[1]
      buffer[offset + 2] = pixel[2]
      buffer[offset + 3] = pixel[3]
    }
  }
  return buffer
}
