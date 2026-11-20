#!/usr/bin/env node
/**
 * 红队模式自检：确认「红队模式」预设在本机宿主里能不能注册、有没有 never-started 条目。
 *
 * 用法：
 *   node scripts/check-redteam-preset.mjs
 *   node scripts/check-redteam-preset.mjs --home "D:\\DeepSeek Harness\\.dsh"
 *
 * 判读：
 *   HEALTHY            → 重启宿主后模式下拉里就有「红队模式」
 *   ACTIVE BROKEN      → 说明预设文件里还有解析不到的包名，按输出的 id/name 修
 *   preset missing     → 插件没跑过，先在宿主里启用 pi-purge 并重启
 *   declare phase 非 registered → 插件注册失败，看 error 字段
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const homeFlag = args.indexOf('--home')
const DSH_HOME = homeFlag >= 0 ? args[homeFlag + 1] : (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * 宿主装着 `@deepseek-ai/dsh` 的那棵 node_modules 是唯一可信的解析基准。
 *
 * `DSH_INSTALL_DIR` 可能是三种写法，都要认：
 *   `/…/@deepseek-ai/dsh`              → 取它自己的 package.json
 *   `/…/@deepseek-ai/dsh/package.json` → 直接用
 *   `/…/@deepseek-ai/dsh/lib/index.js` → 上溯到 dsh 包目录
 * 早前只取 "/@deepseek-ai/" 之前那段拼 package.json，得到的是 node_modules
 * 目录本身 —— 那底下没有 package.json，于是这个 base 静默失效，
 * 服务器上把 dsh-tool-web / tool-todo / tool-schedule 全伪报成解析失败。
 */
function installDirBase(installDir) {
  const p = installDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const candidates = [p]
  if (p.endsWith('/package.json')) candidates.push(path.dirname(p))
  const at = p.lastIndexOf('/@deepseek-ai/dsh')
  if (at > 0) candidates.push(p.slice(0, at + '/@deepseek-ai/dsh'.length))
  for (const dir of candidates) {
    const pkg = dir.endsWith('/package.json') ? dir : path.join(dir, 'package.json')
    if (exists(pkg)) return pkg
  }
  return null
}

function requireBases(home) {
  const list = []
  for (const profile of ['desktop', 'web', 'default', 'headless']) {
    const pkg = path.join(home, 'profiles', profile, 'package.json')
    if (exists(pkg)) list.push(pkg)
  }
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir) {
    const base = installDirBase(installDir)
    if (base) list.push(base)
  }
  const guesses = [
    'D:/DeepseekHarnessDesktop/resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json',
    'C:/Program Files/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json',
    path.join(home, 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    // Linux 全局装的宿主：`npm i -g @deepseek-ai/dsh` 落在 <prefix>/lib/node_modules
    '/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/data/deepseek-harness/npm-global/lib/node_modules/@deepseek-ai/dsh/package.json',
  ]
  for (const g of guesses) if (exists(g)) list.push(g)
  // 预设里 `pi-purge/redteam/tools` 这类本插件自己的子路径，
  // 在没有 profile 的裸 home 下也要能解析，否则自检会伪报 redteam-tools 缺失。
  const selfPkg = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'package.json')
  if (exists(selfPkg)) list.push(selfPkg)
  return [...new Set(list)]
}

/**
 * 极简 YAML 读法：只取 `- id:` / `name:` / `disabled:` 三样。
 * 预设里有 `!!js` 标签，正规 YAML 库会警告，这里绕开。
 */
function readEntries(text) {
  const rows = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) {
      if (cur) rows.push(cur)
      cur = { id: idMatch[1], name: null, disabled: null }
      continue
    }
    if (!cur) continue
    const nameMatch = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch && cur.name === null) {
      let value = nameMatch[1]
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1)
      }
      cur.name = value
      continue
    }
    const disabledMatch = /^\s*disabled:\s*(true|false)\s*$/.exec(line)
    if (disabledMatch && cur.disabled === null) cur.disabled = disabledMatch[1] === 'true'
  }
  if (cur) rows.push(cur)
  return rows
}

const presetDir = path.join(DSH_HOME, '.agent-presets', 'redteam')
const presetFile = path.join(presetDir, 'agent.cordis.yml')
const metaFile = path.join(presetDir, 'preset.yml')
const declareFile = path.join(DSH_HOME, 'redteam', 'preset-declare.json')

console.log('DSH_HOME :', DSH_HOME)
console.log('预设文件 :', presetFile, exists(presetFile) ? '' : '（缺失）')
if (exists(metaFile)) {
  const meta = fs.readFileSync(metaFile, 'utf8').trim().split(/\r?\n/)
  console.log('预设元数据:', meta.join(' | '))
}

if (!exists(presetFile)) {
  console.log('\n结果: preset missing —— 先在宿主里启用 pi-purge 并重启一次，让插件落地预设。')
  process.exit(1)
}

const bases = requireBases(DSH_HOME)
console.log('解析基准 :', bases.length ? bases.join(', ') : '（没找到宿主 package.json）')

const rows = readEntries(fs.readFileSync(presetFile, 'utf8'))
const required = [] // 能为 null 的 name 是相对路径 / cordis 组，跳过
for (const row of rows) {
  const name = row.name
  if (!name || name.startsWith('.') || name.startsWith('cordis:')) continue
  let ok = false
  for (const base of bases) {
    try { createRequire(base).resolve(name); ok = true; break } catch { /* next base */ }
  }
  if (!ok) required.push(row)
}

const active = required.filter((r) => r.disabled !== true)
console.log('\n条目总数 :', rows.length)
if (required.length === 0) {
  console.log('解析失败 : 无')
} else {
  for (const r of required) {
    console.log(`解析失败 : id=${r.id}  name=${r.name}  disabled=${r.disabled === true}`)
  }
}

if (exists(declareFile)) {
  const dec = readJson(declareFile)
  console.log('\n上次注册 :', dec ? `${dec.phase}  ok=${dec.ok}  plugins=${dec.plugins}` : '（读不出）')
  if (dec && dec.broken) console.log('broken   :', String(dec.broken).replace(/\n/g, ' / '))
  if (dec && dec.error) console.log('error    :', dec.error, dec.error === 'line 35: unexpected indentation' ? '（历史残留，writeStatus 是 merge 写入，非当前错误）' : '')
} else {
  console.log('\n上次注册 : preset-declare.json 不存在（宿主还没跑过带红队入口的那次启动）')
}

console.log('')
if (active.length) {
  console.log('结果: ACTIVE BROKEN —— 上面这些条目解析不到，整份预设会被标记 registered-broken，')
  console.log('      模式下拉里就没有「红队模式」。把 name 改成实际安装的包名，或给它加 disabled: true。')
  process.exit(2)
}
console.log('结果: HEALTHY —— 没有活跃的缺失条目。托盘完全退出宿主再启动，「红队模式」会出现在模式下拉里。')
