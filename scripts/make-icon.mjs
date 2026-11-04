#!/usr/bin/env node
/**
 * 生成应用图标（计划工程结构里的 resources/icons/icon.ico）。
 *
 * 为什么用代码画而不是找一张图：交付物必须可复现且不含任何第三方素材
 * （规格 §1/§7 的品牌边界同样适用于自己的图标）。
 * 做法：2× 超采样逐像素绘制 → 盒式降采样得到抗锯齿 → 自写 PNG 编码（filter=None + zlib），
 * 再交给随包 FFmpeg 的 ico muxer 打包成多尺寸 .ico（16/32/48/64/128/256）。
 *
 * 用法：node scripts/make-icon.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconsDir = path.join(root, 'resources', 'icons')
const buildDir = path.join(root, 'resources', 'build')

const SIZE = 1024
/**
 * 超采样倍数：取 3 使 WORK=3072 能被所有目标尺寸整除（16/32/48/64/128/256 与 1024）。
 * SS=2 时 WORK=2048，2048/48 不整除，盒式降采样会失真；而 48px 是 Windows 图标的必需档位。
 */
const SS = 3
const WORK = SIZE * SS

// ---------------------------------------------------------------------------
// 画布与绘制
// ---------------------------------------------------------------------------

/** RGBA 缓冲，初始全透明。 */
const canvas = new Uint8ClampedArray(WORK * WORK * 4)

function putPixel(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= WORK || y >= WORK) return
  const i = (y * WORK + x) * 4
  const dstA = a / 255
  const srcA = canvas[i + 3] / 255
  if (dstA <= 0) return
  // 普通 over 合成（非预乘），保证多次绘制叠加正确
  const outA = dstA + srcA * (1 - dstA)
  const blend = (dst, src) => (src * dstA + srcA * (1 - dstA) * dst) / (outA === 0 ? 1 : outA)
  canvas[i] = blend(canvas[i], r)
  canvas[i + 1] = blend(canvas[i + 1], g)
  canvas[i + 2] = blend(canvas[i + 2], b)
  canvas[i + 3] = Math.round(outA * 255)
}

function fillRect(x, y, w, h, color, alpha = 255) {
  const [r, g, b] = color
  for (let yy = Math.round(y * SS); yy < Math.round((y + h) * SS); yy++) {
    for (let xx = Math.round(x * SS); xx < Math.round((x + w) * SS); xx++) {
      putPixel(xx, yy, r, g, b, alpha)
    }
  }
}

function insideRounded(x, y, box, radius) {
  const [bx, by, bw, bh] = box
  const right = bx + bw
  const bottom = by + bh
  if (x < bx || x >= right || y < by || y >= bottom) return false
  const cx = Math.max(bx + radius, Math.min(right - radius, x))
  const cy = Math.max(by + radius, Math.min(bottom - radius, y))
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

function fillRounded(box, radius, color, alpha = 255, verticalTop = null, verticalBottom = null) {
  const [bx, by, bw, bh] = box
  const top = verticalTop ?? color
  const bottom = verticalBottom ?? color
  for (let y = Math.round(by * SS); y < Math.round((by + bh) * SS); y++) {
    const t = bh === 0 ? 0 : (y / SS - by) / bh
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t)
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t)
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t)
    for (let x = Math.round(bx * SS); x < Math.round((bx + bw) * SS); x++) {
      if (!insideRounded(x / SS, y / SS, box, radius)) continue
      putPixel(x, y, r, g, b, alpha)
    }
  }
}

// 1) 底板：深蓝圆角方块，四角透明（图标外形）
fillRounded(
  [40, 40, SIZE - 80, SIZE - 80],
  180,
  [15, 26, 43],
  255,
  [18, 32, 54],
  [9, 16, 27]
)

// 2) 标题字形：三条递减的白色圆角线（暗示标题，不含任何可读文字）
const glyph = [231, 237, 245]
fillRounded([176, 268, 560, 46], 23, glyph)
fillRounded([176, 344, 424, 46], 23, glyph)
fillRounded([176, 420, 300, 46], 23, glyph)

// 3) 主条（下三分之一）+ 左侧金饰条
fillRounded([140, 588, 744, 116], 18, [22, 50, 63])
fillRect(140, 588, 34, 116, [201, 162, 39])
// 主条上的文字行（白色）
fillRounded([206, 632, 430, 30], 15, [255, 255, 255])

// 4) 副条：与主条错位叠压（本产品的标志性结构）
fillRounded([176, 716, 648, 78], 14, [43, 63, 85])
fillRounded([224, 742, 300, 24], 12, [159, 178, 200])

// ---------------------------------------------------------------------------
// 降采样 + PNG 编码
// ---------------------------------------------------------------------------

function downsample(target = SIZE) {
  const out = Buffer.alloc(target * target * 4)
  const block = WORK / target
  if (!Number.isInteger(block)) throw new Error(`目标尺寸必须整除 ${WORK}：${target}`)
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < block; sy++) {
        for (let sx = 0; sx < block; sx++) {
          const i = ((y * block + sy) * WORK + (x * block + sx)) * 4
          // 预乘累加，避免透明边缘被拉灰
          const alpha = canvas[i + 3] / 255
          r += canvas[i] * alpha
          g += canvas[i + 1] * alpha
          b += canvas[i + 2] * alpha
          a += canvas[i + 3]
        }
      }
      const o = (y * target + x) * 4
      const meanA = a / (block * block)
      if (meanA > 0) {
        out[o] = Math.round(r / (block * block) / (meanA / 255))
        out[o + 1] = Math.round(g / (block * block) / (meanA / 255))
        out[o + 2] = Math.round(b / (block * block) / (meanA / 255))
      }
      out[o + 3] = Math.round(meanA)
    }
  }
  return out
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgba) {
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
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 多尺寸 .ico（Vista+ 的 PNG-in-ICO 形式）。
 * 不用 FFmpeg 的 ico muxer：本机构建（9.0.2）既不认 `-icon_sizes`，
 * 又要求输入 ≤256，一次只能写一条——凑不出 16/32/48/64/128/256 全套。
 * ICO 就是个目录结构：ICONDIR + 若乾 ICONDIRENTRY + 若乾 PNG 块。
 */
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)
  const entryTable = Buffer.alloc(16 * entries.length)
  let offset = header.length + entryTable.length
  const bodies = []
  entries.forEach((entry, index) => {
    const { size, png } = entry
    const base = index * 16
    // 256 在单字节字段里记为 0（惯例）
    entryTable.writeUInt8(size >= 256 ? 0 : size, base)
    entryTable.writeUInt8(size >= 256 ? 0 : size, base + 1)
    entryTable.writeUInt8(0, base + 2) // 调色板颜艃数
    entryTable.writeUInt8(0, base + 3) // reserved
    entryTable.writeUInt16LE(1, base + 4) // planes
    entryTable.writeUInt16LE(32, base + 6) // bit count
    entryTable.writeUInt32LE(png.length, base + 8)
    entryTable.writeUInt32LE(offset, base + 12)
    offset += png.length
    bodies.push(png)
  })
  return Buffer.concat([header, entryTable, ...bodies])
}

async function main() {
  await fs.mkdir(iconsDir, { recursive: true })
  await fs.mkdir(buildDir, { recursive: true })

  const png = encodePng(SIZE, SIZE, downsample(SIZE))
  const pngPath = path.join(iconsDir, 'icon.png')
  await fs.writeFile(pngPath, png)
  console.log(`  ✓ ${path.relative(root, pngPath)} ${(png.length / 1024).toFixed(1)}KB`)

  // electron-builder 的 buildResources 约定位置（放 png 也能自动转 ico/icns）
  await fs.copyFile(pngPath, path.join(buildDir, 'icon.png'))

  const entries = ICO_SIZES.map((size) => ({ size, png: encodePng(size, size, downsample(size)) }))
  const ico = encodeIco(entries)
  const icoPath = path.join(iconsDir, 'icon.ico')
  await fs.writeFile(icoPath, ico)

  // 自校：把刚写的容器读回来，确认目录项与尺寸一致（否则 electron-builder 只会拿到一个坏图标）
  const readBack = await fs.readFile(icoPath)
  if (readBack.readUInt16LE(2) !== 1 || readBack.readUInt16LE(4) !== ICO_SIZES.length) {
    throw new Error('ico 目录头写回校验失败')
  }
  for (let index = 0; index < ICO_SIZES.length; index++) {
    const size = ICO_SIZES[index]
    const base = 6 + index * 16
    const w = readBack.readUInt8(base) === 0 ? 256 : readBack.readUInt8(base)
    const pngStart = readBack.readUInt32LE(base + 12)
    if (w !== size || readBack[pngStart] !== 0x89 || readBack.toString('ascii', pngStart + 12, pngStart + 16) !== 'IHDR') {
      throw new Error(`ico 第 ${index} 项（${size}）损坏`)
    }
  }
  console.log(`  ✓ ${path.relative(root, icoPath)} ${(ico.length / 1024).toFixed(1)}KB（${ICO_SIZES.join('/')} px）`)
}

main().catch((error) => {
  console.error(`✗ 图标生成失败：${error.message}`)
  process.exit(1)
})
