#!/usr/bin/env node
/**
 * 导出管线冒烟测试（M0-5 / M4-6）。
 * 用纯 Node 生成带 alpha 的 RGBA PNG 帧 → image2pipe 直送 FFmpeg stdin → ProRes 4444 MOV，
 * 再用 ffprobe 断言像素格式 / fourcc / 帧数 / 帧率，并打印实测码率用于标定体积系数。
 *
 * 用法：
 *   npm run smoke
 *   node scripts/smoke-export.mjs --width 1920 --height 1080 --fps 30000/1001 --seconds 10
 *   node scripts/smoke-export.mjs --png-seq            # 走 PNG 序列回退路径
 *   node scripts/smoke-export.mjs --overlay --seconds 5  # 叠加合成（计划 §测试计划）
 * 叠加模式额外断言：输出帧率=参考、pix_fmt=yuv420p（锁定计划 C3）、音轨存在、整条透传。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'spikes', 'artifacts')
const BIN = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const PROBE = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const WIDTH = Number(arg('width', 1920))
const HEIGHT = Number(arg('height', 1080))
const FPS_ARG = arg('fps', '30000/1001')
const SECONDS = Number(arg('seconds', 10))
const [FPS_NUM, FPS_DEN] = FPS_ARG.includes('/')
  ? [Number(FPS_ARG.split('/')[0]), Number(FPS_ARG.split('/')[1])]
  : [Number(FPS_ARG), 1]
const FRAMES = Math.round((SECONDS * FPS_NUM) / FPS_DEN)
const USE_PNG_SEQ = process.argv.includes('--png-seq')
const OVERLAY = process.argv.includes('--overlay')

// ---------------------------------------------------------------------------
// 极简 PNG 编码（8bit RGBA，filter=None），保证与 Canvas 产物同格式（PNG straight alpha）
// ---------------------------------------------------------------------------

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
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 一帧内容：全透明底 + 主条 + 50% alpha 副条 + 强调色斜线，用于校验 alpha 与色彩。 */
function frameRgba(frame) {
  const buffer = Buffer.alloc(WIDTH * HEIGHT * 4)
  const barTop = Math.round(HEIGHT * 0.78)
  const barHeight = Math.round(HEIGHT * 0.09)
  const subTop = barTop + barHeight - Math.round(HEIGHT * 0.006)
  const subHeight = Math.round(HEIGHT * 0.06)
  const reveal = Math.min(1, frame / 8 + 0.25)
  const barRight = Math.round(WIDTH * 0.58 * reveal)

  for (let y = barTop; y < barTop + barHeight && y < HEIGHT; y++) {
    for (let x = Math.round(WIDTH * 0.05); x < barRight; x++) {
      const i = (y * WIDTH + x) * 4
      buffer[i] = 0x14
      buffer[i + 1] = 0x3a
      buffer[i + 2] = 0x6b
      buffer[i + 3] = 0xff
    }
  }
  for (let y = subTop; y < subTop + subHeight && y < HEIGHT; y++) {
    for (let x = Math.round(WIDTH * 0.05); x < Math.round(WIDTH * 0.46 * reveal); x++) {
      const i = (y * WIDTH + x) * 4
      buffer[i] = 0x0a
      buffer[i + 1] = 0x1a
      buffer[i + 2] = 0x30
      buffer[i + 3] = 0x80 // 50% alpha：用于验证透明通道确实被编码
    }
  }
  // 强调色斜线（逐帧位移），验证动画位移可被逐帧还原
  const offset = Math.round((frame % Math.max(1, FRAMES)) * 2)
  for (let t = 0; t < barHeight; t++) {
    const x = Math.round(WIDTH * 0.05) + t + offset
    const y = barTop + t
    if (y >= HEIGHT || x >= WIDTH) continue
    const i = (y * WIDTH + x) * 4
    buffer[i] = 0xc9
    buffer[i + 1] = 0xa2
    buffer[i + 2] = 0x27
    buffer[i + 3] = 0xff
  }
  return buffer
}

function spawnAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...options })
    const stdout = []
    let stderr = ''
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr }))
  })
}

/** 必须成功的命令（生成参考视频等）：非 0 退出码直接带上 stderr 尾部报错。 */
async function spawnOrThrow(file, args, label) {
  const result = await spawnAsync(file, args)
  if (result.code !== 0) {
    throw new Error(`${label}失败（退出码 ${result.code}）：${result.stderr.slice(-600)}`)
  }
  return result
}

/** 与 src/shared/ffmpegArgs.ts 保持一致的关键参数（此处内联以便脚本独立运行）。 */
function proresArgsInto(outputPath) {
  return [
    '-c:v',
    'prores_ks',
    '-profile:v',
    '4',
    '-pix_fmt',
    'yuva444p10le',
    '-vendor',
    'apl0',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-an',
    '-f',
    'mov',
    outputPath
  ]
}

function writeWithBackpressure(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) return reject(new Error('stdin 已关闭'))
    const onError = (error) => reject(error)
    const ok = stream.write(chunk, (error) => {
      if (error) reject(error)
    })
    if (ok) {
      stream.removeListener('error', onError)
      resolve()
    } else {
      stream.once('drain', () => {
        stream.removeListener('error', onError)
        resolve()
      })
      stream.once('error', onError)
    }
  })
}

async function readJson(file, args) {
  const result = await spawnAsync(file, args)
  if (result.code !== 0) throw new Error(`ffprobe 失败：${result.stderr.slice(-400)}`)
  return JSON.parse(result.stdout)
}

async function main() {
  await fs.mkdir(outDir, { recursive: true })
  const started = Date.now()
  const outputPath = path.join(outDir, `smoke-${WIDTH}x${HEIGHT}-${FPS_ARG.replace('/', '-')}.mov`)
  await fs.rm(outputPath, { force: true })

  let stderrAll = ''
  if (USE_PNG_SEQ) {
    const seqDir = path.join(outDir, 'frames')
    await fs.rm(seqDir, { recursive: true, force: true })
    await fs.mkdir(seqDir, { recursive: true })
    for (let i = 0; i < FRAMES; i++) {
      await fs.writeFile(path.join(seqDir, `frame_${String(i).padStart(6, '0')}.png`), encodePng(WIDTH, HEIGHT, frameRgba(i)))
    }
    const result = await spawnAsync(BIN, [
      '-hide_banner',
      '-y',
      '-loglevel', 'warning',
      '-framerate',
      FPS_ARG,
      '-start_number',
      '0',
      '-i',
      path.join(seqDir, 'frame_%06d.png'),
      ...proresArgsInto(outputPath)
    ])
    stderrAll = result.stderr
    if (result.code !== 0) throw new Error(`PNG 序列编码失败：${result.stderr.slice(-600)}`)
    await fs.rm(seqDir, { recursive: true, force: true })
  } else {
    const child = spawn(
      BIN,
      [
        '-hide_banner',
        '-y',
        '-loglevel', 'warning',
        '-progress',
        'pipe:1',
        '-nostats',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-framerate',
        FPS_ARG,
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-i',
        'pipe:0',
        ...proresArgsInto(outputPath)
      ],
      { windowsHide: true }
    )
    child.stderr.on('data', (chunk) => {
      stderrAll += chunk.toString()
    })
    // 子进程提前退出时 stdin 会 EPIPE：挂一个被动监听防未处理异常，
    // 真正的归因交给 writeWithBackpressure 的 reject（带上 ffmpeg stderr）
    child.stdin.on('error', () => {})
    const closeCode = new Promise((resolve) => child.on('close', resolve))
    let written = 0
    try {
      for (let i = 0; i < FRAMES; i++) {
        await writeWithBackpressure(child.stdin, encodePng(WIDTH, HEIGHT, frameRgba(i)))
        written = i + 1
      }
    } catch (error) {
      throw new Error(
        `写入第 ${written} 帧失败：${error.message}\nffmpeg 输出：${stderrAll.slice(-800) || '（无）'}`
      )
    }
    child.stdin.end()
    const code = await closeCode
    if (code !== 0) throw new Error(`FFmpeg 退出码 ${code}：${stderrAll.slice(-600)}`)
  }

  // 计划 C1：profile 选错时 FFmpeg 不报错，只打日志，必须显式检测
  if (stderrAll.includes('will not encode alpha')) {
    throw new Error('命中「Profile selected will not encode alpha」：alpha 被静默丢弃')
  }

  const elapsedMs = Date.now() - started
  const stat = await fs.stat(outputPath)
  const info = await readJson(PROBE, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,codec_name,codec_tag_string,color_space,color_range',
    '-show_format',
    '-of',
    'json',
    '-hide_banner',
    outputPath
  ])
  const stream = info.streams?.[0]
  if (!stream) throw new Error('产物无视频流')

  const checks = []
  const expect = (label, actual, predicate) => {
    const ok = predicate(actual)
    checks.push({ label, actual, ok })
  }
  expect('宽度', stream.width, (v) => v === WIDTH)
  expect('高度', stream.height, (v) => v === HEIGHT)
  // 注意：ProRes 4444 解码后的 pix_fmt 为 yuva444p12le（12 位存储），不能断言成 10le
  expect('像素格式（带 alpha）', stream.pix_fmt, (v) => typeof v === 'string' && v.startsWith('yuva'))
  expect('fourcc', stream.codec_tag_string, (v) => v === 'ap4h' || v === 'ap4x')
  expect('帧数', stream.nb_frames, (v) => Number(v) === FRAMES)
  expect('帧率', stream.r_frame_rate, (v) => v === `${FPS_NUM}/${FPS_DEN}` || Math.abs(evalFraction(v) - FPS_NUM / FPS_DEN) < 1e-6)
  expect('色彩范围', stream.color_range, (v) => v === 'tv')

  // alpha 通道校验：抽出 alpha 平面后统计均值，应显著小于 255（说明存在透明/半透明）
  const midFrame = Math.floor(FRAMES / 2)
  // metadata=print 输出在 stderr（-f null 不产生 stdout），因此不能用 readJson
  const alphaRun = await spawnAsync(BIN, [
    '-hide_banner',
    '-v',
    'info',
    '-i',
    outputPath,
    '-vf',
    `select=eq(n\\,${midFrame}),format=rgba,alphaextract,signalstats,metadata=print`,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-'
  ])
  const yavg = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(alphaRun.stderr)?.[1]
  expect('alpha 均值（应 <250）', yavg === undefined ? '未取到' : Number(yavg), (v) => typeof v === 'number' && v < 250)

  const mbps = ((stat.size * 8) / 1e6 / SECONDS).toFixed(1)
  const bitsPerPixelFrame = ((stat.size * 8) / (WIDTH * HEIGHT * FRAMES)).toFixed(3)

  console.log(`\n产物：${outputPath}`)
  console.log(`体积：${(stat.size / 1024 / 1024).toFixed(1)} MB · ${mbps} Mbps · ${bitsPerPixelFrame} bit/pixel/frame`)
  console.log(`耗时：${(elapsedMs / 1000).toFixed(1)}s（${FRAMES} 帧，${(FRAMES / (elapsedMs / 1000)).toFixed(0)} fps 等效）`)
  console.log(`\n建议标定值：PRORES_4444_BITS_PER_PIXEL_FRAME ≈ ${bitsPerPixelFrame}（取本次与实测基准的较大者作为保守上界）`)
  if (elapsedMs / 1000 > 30 && WIDTH >= 1920 && SECONDS >= 10) {
    console.warn('⚠ 1080p/10s 导出超过 30 秒，与验收标准（≤30s）冲突，需要优化帧编码或管道')
  }

  /**
   * 叠加合成阶段（计划 §测试计划明列在本脚本）：
   * 拿刚生成的透明 MOV 叠到一个合成参考视频上，断言输出帧率=参考、
   * pix_fmt=yuv420p（锁定计划 C3）、音轨存在、整条时间轴透传。
   * filter_complex 与 src/shared/ffmpegArgs.ts 的 buildFilterComplex 同参
   *（那边由 tests/ffmpegArgs.test.ts 锁住；本脚本是交付工程师不依赖 Electron 也能跑的那一份）。
   */
  if (OVERLAY) {
    const tag = `${WIDTH}x${HEIGHT}-${FPS_ARG.replace('/', '-')}`
    const refPath = path.join(outDir, `smoke-ref-${tag}.mp4`)
    const overlayOut = path.join(outDir, `smoke-overlay-${tag}.mp4`)
    await fs.rm(refPath, { force: true })
    await fs.rm(overlayOut, { force: true })

    await spawnOrThrow(BIN, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS_ARG}:duration=${SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=500:sample_rate=48000:duration=${SECONDS}`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', refPath
    ], '参考视频生成')

    const spanStart = Math.min(0.5, SECONDS * 0.1)
    const spanEnd = Math.max(spanStart + 0.5, SECONDS - 0.5)
    const filter =
      `[0:v]fps=${FPS_ARG},setsar=1[v0];` +
      `[1:v]setpts=PTS+${spanStart.toFixed(3)}/TB[ov];` +
      `[v0][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:` +
      `enable='between(t,${spanStart.toFixed(3)},${spanEnd.toFixed(3)})',format=yuv420p[v]`

    const composite = await spawnAsync(BIN, [
      '-hide_banner', '-y', '-loglevel', 'warning',
      '-i', refPath, '-i', outputPath,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-fps_mode', 'cfr',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'copy', '-movflags', '+faststart', overlayOut
    ])
    if (composite.code !== 0) {
      checks.push({ label: '叠加合成退出码', actual: `${composite.code} ${composite.stderr.slice(-300)}`, ok: false })
    } else {
      // 两边的字段表必须一齐：计划 C24 的坑就是 -show_entries 一旦漏写 codec_name，
      // 对侧拿到 undefined，断言会“看起来值相等却失败”。
      const refInfo = await readJson(PROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,pix_fmt', '-of', 'json', refPath])
      const outInfo = await readJson(PROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,pix_fmt', '-of', 'json', overlayOut])
      const refVideo = (refInfo.streams ?? []).find((s) => s.codec_type === 'video') ?? {}
      const refAudio = (refInfo.streams ?? []).find((s) => s.codec_type === 'audio')
      const outVideo = (outInfo.streams ?? []).find((s) => s.codec_type === 'video') ?? {}
      const outAudio = (outInfo.streams ?? []).find((s) => s.codec_type === 'audio')

      expect('宽度跟随参考', outVideo.width, (v) => v === refVideo.width)
      expect('高度跟随参考', outVideo.height, (v) => v === refVideo.height)
      expect('帧率跟随参考', outVideo.r_frame_rate, (v) => v === refVideo.r_frame_rate)
      // 计划 C3：overlay=...format=auto 会把输出升到 10-bit 4:4:4，链尾必须回到 yuv420p
      expect('像素格式回到 yuv420p', outVideo.pix_fmt, (v) => v === 'yuv420p')
      expect('视频编码 h264', outVideo.codec_name, (v) => v === 'h264')
      expect('音轨保留（-c:a copy）', outAudio ? outAudio.codec_name : null, (v) => v !== null && v !== undefined && v === (refAudio ? refAudio.codec_name : null))
      if (refVideo.nb_frames && outVideo.nb_frames) {
        expect('整条时间轴透传（帧数一致）', outVideo.nb_frames, (v) => Math.abs(Number(v) - Number(refVideo.nb_frames)) <= 1)
      }
      console.log(`\n叠加产物：${overlayOut}`)
      console.log(`  span ${spanStart.toFixed(3)}s..${spanEnd.toFixed(3)}s · 参考 ${refVideo.width}x${refVideo.height} @${refVideo.r_frame_rate} · 音频 ${outAudio?.codec_name ?? '无'}`)
    }
  }

  /**
   * 所有断言（含叠加阶段）统一在此打印并计数。
   * 之前先打印再追加叠加断言，会让叠加失败默默通过。
   */
  console.log('\n断言（OK/FAIL）：')
  let failed = 0
  for (const check of checks) {
    // 用 ASCII 标记：中文 Windows 控制台重定向时 ✓/✗ 会碎成同一串乱码，CI 里看不出哪行失败
    console.log(`  ${check.ok ? 'OK  ' : 'FAIL'} ${check.label} = ${String(check.actual)}`)
    if (!check.ok) failed += 1
  }

  if (failed > 0) {
    console.error(`\nSMOKE FAIL: ${failed} 项断言未通过`)
    process.exit(1)
  }
  console.log('\nSMOKE PASS（sha256 ' + crypto.createHash('sha256').update(await fs.readFile(outputPath)).digest('hex').slice(0, 16) + '…）')
}

function evalFraction(value) {
  const [n, d] = String(value).split('/').map(Number)
  return d ? n / d : n
}

main().catch((error) => {
  console.error(`\nSMOKE FAIL: ${error.message}`)
  process.exit(1)
})
