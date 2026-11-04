#!/usr/bin/env node
/**
 * 生成真实的 ffprobe 夹具（计划 §测试计划：probe 夹具需覆盖 SDR/16:9、HDR、VFR、9:16、无音轨、alac 音轨）。
 *
 * 为什么不用手写 JSON：`parseProbeJson` 要面对的是**真实 ffprobe 的字段形状**
 * （HDR 标签在 side_data / 顶层混排、无音轨时 streams 只有一条、alac 的 sample_fmt、
 * VFR 的 r_frame_rate 与 avg_frame_rate 分离）。手写对象只会验证我已经想到的形状。
 *
 * 用法：node scripts/make-probe-fixtures.mjs        # 重新生成全部夹具
 * 夹具落盘 tests/fixtures/*.json（入库），中间视频落 spikes/fixtures-tmp（不入库）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = path.join(root, 'tests', 'fixtures')
const workDir = path.join(root, 'spikes', 'fixtures-tmp')
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG = path.join(root, 'resources', 'ffmpeg', `ffmpeg${EXE}`)
const FFPROBE = path.join(root, 'resources', 'ffmpeg', `ffprobe${EXE}`)

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${path.basename(file)} ${args.join(' ')} 退出码 ${code}\n${stderr.slice(-800)}`))
    })
  })
}

const ffmpeg = (args) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args])
const ffprobe = (args) => run(FFPROBE, ['-hide_banner', '-v', 'error', ...args])

async function writeFixture(name, payload) {
  const file = path.join(fixtureDir, name)
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`  ✓ ${name}`)
}

const PROBE_ARGS = ['-print_format', 'json', '-show_streams', '-show_format']

async function main() {
  await fs.mkdir(fixtureDir, { recursive: true })
  await fs.mkdir(workDir, { recursive: true })

  // 1) SDR / 16:9 / aac 音轨
  const sdr = path.join(workDir, 'sdr.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-shortest', sdr
  ])
  await writeFixture('probe-sdr-169.json', JSON.parse(await ffprobe([...PROBE_ARGS, sdr])))

  // 2) HDR：bt2020 原色 + smpte2084(PQ) 传输 + bt2020nc 矩阵，10-bit
  //    必须走 x264-params 写进 SPS VUI：只给 -color_primaries/-color_trc 时，
  //    真实 ffprobe 输出里根本不会有 color_primaries/color_transfer 字段（实测只有 color_space），
  //    那样夹具就测不到 HDR 判定的主路径。
  const hdr = path.join(workDir, 'hdr.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=25:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colmatrix=bt2020nc',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
    hdr
  ])
  const hdrJson = JSON.parse(await ffprobe([...PROBE_ARGS, hdr]))
  const hdrVideo = hdrJson.streams?.find((stream) => stream.codec_type === 'video')
  if (!hdrVideo || hdrVideo.color_transfer !== 'smpte2084') {
    throw new Error('HDR 夹具未能在 ffprobe 输出里带出 color_transfer，夹具不合格')
  }
  await writeFixture('probe-hdr-bt2020-pq.json', hdrJson)

  // 3) 竖屏 9:16
  const portrait = path.join(workDir, 'portrait.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', portrait
  ])
  await writeFixture('probe-portrait-916.json', JSON.parse(await ffprobe([...PROBE_ARGS, portrait])))

  // 4) 无音轨（计划 C4 的触发场景：-c:a copy 会直接失败）
  const noAudio = path.join(workDir, 'noaudio.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=1',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', noAudio
  ])
  await writeFixture('probe-no-audio.json', JSON.parse(await ffprobe([...PROBE_ARGS, noAudio])))

  // 5) alac 音轨（不在 COPYABLE_AUDIO_CODECS 里 → 必须转码）
  const alac = path.join(workDir, 'alac.mov')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'alac', '-shortest', alac
  ])
  await writeFixture('probe-alac-audio.json', JSON.parse(await ffprobe([...PROBE_ARGS, alac])))

  // 6) PCM 音轨（pcm_s16le）：不在可 copy 名单 → 生产应预检转 AAC；
  //    同时它也是「叠加冒烟需要 ≥4s 参考」的音频回退取证夹具。
  const pcm = path.join(workDir, 'audio-pcm.mov')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-shortest', pcm
  ])
  const pcmJson = JSON.parse(await ffprobe([...PROBE_ARGS, pcm]))
  const pcmAudio = pcmJson.streams?.find((stream) => stream.codec_type === 'audio')
  if (!pcmAudio || pcmAudio.codec_name !== 'pcm_s16le') {
    throw new Error('PCM 夹具未能写入 pcm_s16le 音轨')
  }
  await writeFixture('probe-pcm-audio.json', pcmJson)

  // 7) VFR：按不规则间隔丢帧，使 r_frame_rate 与 avg_frame_rate 分离、相邻 PTS 间隔不均
  const vfr = path.join(workDir, 'vfr.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=60:duration=2',
    '-vf', "select='lt(mod(n\\,11),7)'", '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', vfr
  ])
  await writeFixture('probe-vfr.json', JSON.parse(await ffprobe([...PROBE_ARGS, vfr])))
  // analyzeVfrSample 吃的是 packet 抽样（与生产同一命令 buildVfrSampleArgs）
  const packets = JSON.parse(
    await ffprobe([
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'json',
      '-read_intervals', '%+#60',
      vfr
    ])
  )
  await writeFixture('probe-vfr-packets.json', packets)

  // 顺带把关键判定打印出来，便于人工核对夹具确实是预期形状
  const summary = []
  for (const [label, file] of [
    ['sdr', sdr], ['hdr', hdr], ['portrait', portrait], ['noaudio', noAudio], ['alac', alac], ['pcm', pcm], ['vfr', vfr]
  ]) {
    const text = await ffprobe([
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=width,height,r_frame_rate,avg_frame_rate,pix_fmt,color_primaries,color_transfer,color_space',
      '-show_entries', 'format=nb_streams', '-of', 'default=nw=1:nk=1', file
    ])
    summary.push(`${label}: ${text.split('\n').filter(Boolean).join(' ')}`)
  }
  console.log(summary.join('\n'))
  console.log(`✓ 夹具已生成于 ${path.relative(root, fixtureDir)}`)
}

main().catch((error) => {
  console.error(`✗ 生成夹具失败：${error.message}`)
  process.exit(1)
})
