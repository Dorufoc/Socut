#!/usr/bin/env node
/**
 * 内置字体获取脚本（规格 §4.5 / §8）。
 * 全部选用可再分发许可证（SIL OFL / Apache 2.0），并把许可证副本一并落到 resources/fonts/LICENSES/。
 *
 * 用法：
 *   npm run fetch:fonts
 *   npm run fetch:fonts -- --brand              额外处理品牌字体包（华为可随包；OPPO/阿里/腾讯只记录不打包）
 *   BRAND_FONT_DIR=D:/brand-fonts npm run fetch:fonts -- --brand   从官方下载包目录引入可随包字体
 *   FONTS_LOCAL_DIR=D:/fonts npm run fetch:fonts     # 离线：从本地目录按 fileName 复制
 * 特性：
 *   - 单个字体下载失败只告警并跳过（应用侧会忽略缺失文件，不阻塞其它字体）；
 *   - 校验 TTF/OTF 魔数，避免把 HTML 错误页当字体存下来；
 *   - 产出 resources/fonts/manifest.json（fontStore 直接消费，避免启动时全量哈希）。
 * 注意：下方 FONT_FILES 必须与 src/shared/constants.ts 的 BUILTIN_FONTS 保持一致。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'resources', 'fonts')
const licenseDir = path.join(targetDir, 'LICENSES')

const CJK_BASE = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main'
const JBM_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf'

/** 许可证候选 URL（按仓库布局不同，逐个尝试直到命中）。 */
const LICENSE_CANDIDATES = {
  'Noto Sans SC': [`${CJK_BASE}/Sans/LICENSE`, `${CJK_BASE}/LICENSE`],
  'Noto Serif SC': [`${CJK_BASE}/Serif/LICENSE`, `${CJK_BASE}/LICENSE`],
  'JetBrains Mono': [
    // google/fonts 仓库内该字体的许可证文件名是 OFL.txt（不是 LICENSE/LICENSE.txt），
    // 之前三个候选全部 404，导出的许可证一直没能就位。
    'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/OFL.txt',
    'https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt',
    'https://cdn.jsdelivr.net/gh/googlefonts/jetbrains-mono@main/LICENSE',
    'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/LICENSE'
  ]
}

const FONT_FILES = [
  {
    fontId: 'builtin-notosanssc-400',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Regular',
    weight: 400,
    style: 'normal',
    fileName: 'NotoSansSC-Regular.otf',
    url: `${CJK_BASE}/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf`,
    license: 'SIL OFL 1.1'
  },
  {
    fontId: 'builtin-notosanssc-500',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Medium',
    weight: 500,
    style: 'normal',
    fileName: 'NotoSansSC-Medium.otf',
    url: `${CJK_BASE}/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Medium.otf`,
    license: 'SIL OFL 1.1'
  },
  {
    fontId: 'builtin-notosanssc-700',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Bold',
    weight: 700,
    style: 'normal',
    fileName: 'NotoSansSC-Bold.otf',
    url: `${CJK_BASE}/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf`,
    license: 'SIL OFL 1.1'
  },
  {
    fontId: 'builtin-notosanssc-900',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Black',
    weight: 900,
    style: 'normal',
    fileName: 'NotoSansSC-Black.otf',
    url: `${CJK_BASE}/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Black.otf`,
    license: 'SIL OFL 1.1'
  },
  {
    fontId: 'builtin-notoserifsc-700',
    family: 'Noto Serif SC',
    displayName: '思源宋体 Bold',
    weight: 700,
    style: 'normal',
    fileName: 'NotoSerifSC-Bold.otf',
    // 全量 OTF 约 23MB，超过 jsDelivr 的 20MB 限制（403）；SubsetOTF/SC 约 8MB 且覆盖简体中文常用字
    url: `${CJK_BASE}/Serif/SubsetOTF/SC/NotoSerifSC-Bold.otf`,
    license: 'SIL OFL 1.1'
  },
  {
    fontId: 'builtin-jetbrainsmono-400',
    family: 'JetBrains Mono',
    displayName: 'JetBrains Mono Regular',
    weight: 400,
    style: 'normal',
    fileName: 'JetBrainsMono-Variable.ttf',
    url: JBM_URL,
    license: 'SIL OFL 1.1'
  },
  {
    fontId: 'builtin-jetbrainsmono-700',
    family: 'JetBrains Mono',
    displayName: 'JetBrains Mono Bold',
    weight: 700,
    style: 'normal',
    fileName: 'JetBrainsMono-Variable.ttf',
    url: JBM_URL,
    license: 'SIL OFL 1.1'
  }
]

const sha1 = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex')

/**
 * 品牌字体包（用户要求：华为 / OPPO / 阿里 / 腾讯 的免费可商用字体）。
 *
 * `distribution` 是**合规判定**而不是口味，依据是各家协议原文：
 *  - 'bundle'：协议明确授予将**未修改副本**嵌入/捆绑/随非字体软件再分发。
 *    HarmonyOS Sans Fonts License Agreement §2：「允许您使用、复制、合并、嵌入、捆绑、重新分发和/或销售
 *    HarmonyOS Sans Fonts 的未修改副本以及除字体软件以外的任何软件」，条件：不得修改、
 *    不得在独立基础上重新分发或销售、须随附本协议。→ 可进安装包（必须同时随包协议文本）。
 *  - 'import-only'：官方声明只覆盖「使用」（渲染产物），对字体文件随第三方软件再分发
 *    没有明确许可文字（阿里普惠体 3.0 / 腾讯体），或条款直接写了「不向他方提供其他下载渠道」（OPPO Sans 4.0）。
 *    → **不打进安装包**，由最终用户从官方页下载后用应用内「导入字体」引入（合规且零改造）。
 *
 * 这些官方包都在门户页/验证码后面（本机实测直链 404），因此脚本不自动拉字体本体：
 * 开发者从官方页下载一次，放在 BRAND_FONT_DIR 里，脚本做魔数校验 + SHA1 归档 + 写入 manifest。
 */
const BRAND_PACK = [
  {
    id: 'builtin-harmonysanssc-400',
    family: 'HarmonyOS Sans SC',
    displayName: '鸿蒙黑体 Regular',
    weight: 400,
    style: 'normal',
    fileNames: ['HarmonyOS_Sans_SC_Regular.ttf', 'HarmonyOS_SansSC_Regular.ttf'],
    distribution: 'bundle',
    license: 'HarmonyOS Sans Fonts License Agreement（华为）',
    officialPage: 'https://developer.huawei.com/consumer/cn/design/resource-V1/',
    licenseFileNames: ['HarmonyOS-Sans-LICENSE.txt', 'LICENSE.txt', 'HarmonyOS_Sans_Fonts_License_Agreement.txt']
  },
  {
    id: 'builtin-harmonysanssc-500',
    family: 'HarmonyOS Sans SC',
    displayName: '鸿蒙黑体 Medium',
    weight: 500,
    style: 'normal',
    fileNames: ['HarmonyOS_Sans_SC_Medium.ttf', 'HarmonyOS_SansSC_Medium.ttf'],
    distribution: 'bundle',
    license: 'HarmonyOS Sans Fonts License Agreement（华为）',
    officialPage: 'https://developer.huawei.com/consumer/cn/design/resource-V1/',
    licenseFileNames: ['HarmonyOS-Sans-LICENSE.txt', 'LICENSE.txt']
  },
  {
    id: 'builtin-harmonysanssc-700',
    family: 'HarmonyOS Sans SC',
    displayName: '鸿蒙黑体 Bold',
    weight: 700,
    style: 'normal',
    fileNames: ['HarmonyOS_Sans_SC_Bold.ttf', 'HarmonyOS_SansSC_Bold.ttf'],
    distribution: 'bundle',
    license: 'HarmonyOS Sans Fonts License Agreement（华为）',
    officialPage: 'https://developer.huawei.com/consumer/cn/design/resource-V1/',
    licenseFileNames: ['HarmonyOS-Sans-LICENSE.txt', 'LICENSE.txt']
  },
  {
    id: 'builtin-opposans-400',
    family: 'OPPO Sans',
    displayName: 'OPPO Sans Regular',
    weight: 400,
    style: 'normal',
    fileNames: ['OPPOSans-R.ttf', 'OPPO Sans 4.0 R.ttf'],
    distribution: 'import-only',
    license: 'OPPO Sans 免费商用声明（含“不向他方提供其他下载渠道”）',
    officialPage: 'https://open.oppomobile.com/new/developmentDoc/info?id=10221'
  },
  {
    id: 'builtin-opposans-700',
    family: 'OPPO Sans',
    displayName: 'OPPO Sans Bold',
    weight: 700,
    style: 'normal',
    fileNames: ['OPPOSans-B.ttf', 'OPPO Sans 4.0 B.ttf'],
    distribution: 'import-only',
    license: 'OPPO Sans 免费商用声明（含“不向他方提供其他下载渠道”）',
    officialPage: 'https://open.oppomobile.com/new/developmentDoc/info?id=10221'
  },
  {
    id: 'builtin-alibabapuhuiti-400',
    family: 'Alibaba PuHuiTi 3.0',
    displayName: '阿里普惠体 55 Regular',
    weight: 400,
    style: 'normal',
    fileNames: ['AlibabaPuHuiTi-3-55-Regular.ttf', 'AlibabaPuHuiTi-3-55-R.ttf'],
    distribution: 'import-only',
    license: '阿里巴巴普惠体 3.0 免费商用声明（对字体文件随软件再分发无明确文字，待书面确认）',
    officialPage: 'https://fonts.alibabagroup.com/'
  },
  {
    id: 'builtin-alibabapuhuiti-700',
    family: 'Alibaba PuHuiTi 3.0',
    displayName: '阿里普惠体 85 Bold',
    weight: 700,
    style: 'normal',
    fileNames: ['AlibabaPuHuiTi-3-85-Bold.ttf', 'AlibabaPuHuiTi-3-85-B.ttf'],
    distribution: 'import-only',
    license: '阿里巴巴普惠体 3.0 免费商用声明（对字体文件随软件再分发无明确文字，待书面确认）',
    officialPage: 'https://fonts.alibabagroup.com/'
  },
  {
    id: 'builtin-tencentsans-400',
    family: 'Tencent Sans',
    displayName: '腾讯体 Regular',
    weight: 400,
    style: 'normal',
    fileNames: ['TencentSans-WQy-R.ttf', 'TencentSans.ttf'],
    distribution: 'import-only',
    license: '腾讯体免费商用声明（未见到允许嵌入/再分发的条款文字）',
    officialPage: 'https://www.tencent.com/zh-cn/business/tencent-sans.html'
  }
]

async function findFirst(dir, names) {
  if (!dir) return null
  for (const name of names) {
    const candidate = path.join(dir, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

function looksLikeFont(buffer) {
  if (buffer.length < 16) return false
  const sig = buffer.readUInt32BE(0)
  // TrueType(0x00010000) / 'true' / 'OTTO'；拒绝 TTC 集合与 WOFF 压缩包
  return sig === 0x0001_0000 || sig === 0x74_72_75_65 || sig === 0x4f_54_54_4f
}

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function fetchBuffer(url) {
  const proxy = process.env.GH_PROXY
  const finalUrl = proxy && url.includes('github.com') ? `${proxy.replace(/\/$/, '')}/${url}` : url
  const response = await fetch(finalUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  await fs.mkdir(targetDir, { recursive: true })
  await fs.mkdir(licenseDir, { recursive: true })
  const localDir = process.env.FONTS_LOCAL_DIR
  const manifest = { version: 1, generatedAt: new Date().toISOString(), fonts: [] }
  let failed = 0

  for (const entry of FONT_FILES) {
    const destination = path.join(targetDir, entry.fileName)
    let buffer = null
    if (localDir) {
      const candidate = path.join(localDir, entry.fileName)
      if (await exists(candidate)) buffer = await fs.readFile(candidate)
    }
    if (!buffer && (await exists(destination))) buffer = await fs.readFile(destination)
    if (!buffer) {
      try {
        console.log(`→ ${entry.fileName}`)
        buffer = await fetchBuffer(entry.url)
      } catch (error) {
        failed += 1
        console.warn(`⚠ 下载失败（跳过）：${entry.fileName} — ${error.message}`)
        continue
      }
    }
    if (!looksLikeFont(buffer)) {
      failed += 1
      console.warn(`⚠ 不是合法 TTF/OTF（跳过）：${entry.fileName}，可能是错误页或需要换源`)
      continue
    }
    await fs.writeFile(destination, buffer)
    manifest.fonts.push({
      fontId: entry.fontId,
      family: entry.family,
      displayName: entry.displayName,
      weight: entry.weight,
      style: entry.style,
      fileName: entry.fileName,
      bytes: buffer.length,
      sha1: sha1(buffer),
      source: 'builtin',
      importedAt: manifest.generatedAt,
      license: entry.license,
      origin: entry.url
    })
    console.log(`  ✓ ${entry.fileName} ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
  }

  // 许可证按家族只取一次（候选 URL 逐个尝试）
  for (const [family, candidates] of Object.entries(LICENSE_CANDIDATES)) {
    const licenseFile = path.join(licenseDir, `${family.replace(/\s+/g, '')}-LICENSE.txt`)
    if (await exists(licenseFile)) continue
    for (const candidate of candidates) {
      try {
        const license = await fetchBuffer(candidate)
        await fs.writeFile(licenseFile, license)
        console.log(`  ✓ 许可证 ${family} ← ${candidate}`)
        break
      } catch {
        // 试下一个候选
      }
    }
  }

  // 品牌字体包：只在显式 --brand 时处理（默认交付包保持 OFL-only，体积与合规都可控）
  const brandReport = []
  if (process.argv.includes('--brand')) {
    const brandDir = process.env.BRAND_FONT_DIR
    for (const brand of BRAND_PACK) {
      const record = {
        family: brand.family,
        displayName: brand.displayName,
        distribution: brand.distribution,
        officialPage: brand.officialPage,
        license: brand.license
      }
      if (brand.distribution !== 'bundle') {
        record.action = 'import-only'
        brandReport.push(record)
        console.log(
          `ℹ ${brand.family}：协议未授予“字体文件随第三方软件再分发”→ 不打进安装包；
  由用户从 ${brand.officialPage} 下载后在应用内「导入字体」引入（原因：${brand.license}）`
        )
        continue
      }
      const canonical = brand.fileNames[0]
      const destination = path.join(targetDir, canonical)
      const source = (await findFirst(brandDir, brand.fileNames)) ?? ((await exists(destination)) ? destination : null)
      if (!source) {
        record.action = 'missing'
        brandReport.push(record)
        console.warn(
          `⚠ ${brand.family} ${canonical}：未找到。请从 ${brand.officialPage} 下载官方包，` +
            `将字体文件放入 BRAND_FONT_DIR 后重跑（--brand）`
        )
        continue
      }
      const buffer = await fs.readFile(source)
      if (!looksLikeFont(buffer)) {
        record.action = 'invalid'
        brandReport.push(record)
        console.warn(`⚠ ${brand.family}：${source} 不是合法 TTF/OTF（可能是错误页或需解包）`)
        continue
      }
      if (source !== destination) await fs.writeFile(destination, buffer)
      manifest.fonts.push({
        fontId: brand.id,
        family: brand.family,
        displayName: brand.displayName,
        weight: brand.weight,
        style: brand.style,
        fileName: canonical,
        bytes: buffer.length,
        sha1: sha1(buffer),
        source: 'builtin',
        importedAt: manifest.generatedAt,
        license: brand.license,
        origin: `BRAND_FONT_DIR/${path.basename(source)}`
      })
      // 协议本体必须随包（许可条件“须随附本协议”），否则不能分发
      const licenseSource = await findFirst(brandDir, brand.licenseFileNames ?? [])
      const licenseTarget = path.join(licenseDir, `${brand.family.replace(/\s+/g, '')}-LICENSE.txt`)
      if (licenseSource) {
        await fs.copyFile(licenseSource, licenseTarget)
        record.licenseArchived = path.relative(root, licenseTarget)
      } else if (await exists(licenseTarget)) {
        record.licenseArchived = path.relative(root, licenseTarget)
      } else {
        record.licenseMissing = true
        console.warn(
          `⚠ ${brand.family}：协议文本未就位（BRAND_FONT_DIR 里应有 ${
            (brand.licenseFileNames ?? []).join(' / ') || 'LICENSE.txt'
          }）。协议要求随附文本，否则不得分发字体副本。`
        )
      }
      record.action = 'bundled'
      brandReport.push(record)
      console.log(`  ✓ ${brand.family} ${canonical} ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
    }
  }
  manifest.brandPack = brandReport

  await fs.writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`✓ manifest.json 写入 ${manifest.fonts.length} 个字体${failed > 0 ? `（跳过 ${failed} 个）` : ''}`)
  if (manifest.fonts.length === 0) {
    console.error('✗ 一个字体都没有：预设回退字体不可用，请人工放置字体到 resources/fonts/ 并用 FONTS_LOCAL_DIR 重跑')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(`✗ fetch-fonts 失败：${error.message}`)
  process.exit(1)
})
