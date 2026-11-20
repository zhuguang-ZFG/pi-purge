/**
 * 点「应用」/宿主启动时把红队数据目录铺好：知识库、工具箱路径、nuclei 模板。
 * Windows 不能跑 setup.sh，所以这里用 Node 做同等的本机适配。
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { extractZipArchive } from '../zip-extract.js'
import { HAS_FTS5, KNOWLEDGE_DDL, POC_FTS_DDL, migrateKnowledge } from './schema.js'
import {
  loadPlatformConfig, redteamRoot, resolveAllTools, savePlatformConfig, scanFolderForTools,
} from './platform-config.js'
/* 公告层（CISA KEV）与模板刷新同一个节奏：都是「情报保鲜」，失败一律静默 */
import { kevStatus, refreshKevIfStale } from './kev.js'

const GIT_URLS = [
  'https://github.com/projectdiscovery/nuclei-templates.git',
  'https://ghproxy.net/https://github.com/projectdiscovery/nuclei-templates.git',
]

const TAR_URLS = [
  'https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.tar.gz',
  'https://codeload.github.com/projectdiscovery/nuclei-templates/tar.gz/refs/heads/main',
  'https://ghproxy.net/https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.tar.gz',
]

const ZIP_URLS = [
  'https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip',
  'https://ghproxy.net/https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip',
  'https://mirror.ghproxy.com/https://github.com/projectdiscovery/nuclei-templates/archive/refs/heads/main.zip',
]

function collectHomes() {
  const homes = []
  const push = (home) => {
    const dir = String(home || '').trim()
    if (!dir || homes.includes(dir)) return
    homes.push(dir)
  }
  push(process.env.DSH_HOME)
  if (process.platform === 'darwin') {
    push(join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'dsh-home'))
  }
  const fallback = join(homedir(), '.dsh')
  if (existsSync(fallback) || !homes.length) push(fallback)
  return homes.filter((home, i) => i === 0 || existsSync(home))
}

function logLine(root, msg) {
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(join(root, 'bootstrap.log'), new Date().toISOString() + ' ' + msg + '\n', 'utf8')
  } catch { /* 日志失败不挡应用 */ }
}

function countYaml(dir, cap = 80) {
  if (!dir || !existsSync(dir)) return 0
  let n = 0
  const walk = (base, depth) => {
    if (n >= cap || depth > 6) return
    let entries = []
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (n >= cap) return
      const next = join(base, entry.name)
      if (entry.isDirectory()) walk(next, depth + 1)
      else if (/\.ya?ml$/i.test(entry.name)) n += 1
    }
  }
  walk(dir, 0)
  return n
}

function looksLikeTemplates(dir) {
  if (!dir || !existsSync(dir)) return false
  try {
    if (existsSync(join(dir, 'http')) || existsSync(join(dir, 'ssl')) || existsSync(join(dir, 'dns'))) return true
  } catch { /* ignore */ }
  return countYaml(dir, 20) >= 20
}

function discoverTemplates(homes) {
  const extra = [
    join(homedir(), '.local', 'nuclei-templates'),
    join(homedir(), 'nuclei-templates'),
    join(homedir(), 'AppData', 'Local', 'nuclei-templates'),
    '/usr/share/nuclei-templates',
    '/opt/nuclei-templates',
  ]
  const cands = []
  for (const home of homes) {
    const root = join(home, 'redteam')
    cands.push(join(root, 'toolkit', 'nuclei-templates'))
    try {
      const cfg = loadPlatformConfig(root)
      if (cfg.nucleiTemplatesDir) cands.push(cfg.nucleiTemplatesDir)
    } catch { /* ignore */ }
  }
  for (const dir of [...cands, ...extra]) {
    if (looksLikeTemplates(dir)) return dir
  }
  return ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function moveDir(src, dest) {
  if (looksLikeTemplates(dest)) return
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, '..'), { recursive: true })
  try {
    renameSync(src, dest)
  } catch {
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/** 整目录替换：先备份旧库、再换新库；换失败把旧库放回去（宁可不更新，不能让机器上没模板）。 */
function swapDir(src, dest) {
  const backup = dest + '.old-' + process.pid
  rmSync(backup, { recursive: true, force: true })
  const had = existsSync(dest)
  if (had) {
    try { renameSync(dest, backup) } catch { cpSync(dest, backup, { recursive: true }) }
  }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    try { renameSync(src, dest) } catch {
      rmSync(dest, { recursive: true, force: true })
      cpSync(src, dest, { recursive: true })
    }
  } catch (error) {
    try {
      rmSync(dest, { recursive: true, force: true })
      if (had) renameSync(backup, dest)
    } catch { /* 恢复失败只能保留副本，下一次启动会重新发现 */ }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
}

/** 只刷新"自己那份"模板库：用户在 ~/.local/nuclei-templates 或系统目录自己维护的，不碰。 */
function ownsTemplatesDir(dir, root) {
  if (!dir) return false
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(dir).startsWith(norm(join(root, 'toolkit')) + '/')
}

/** 模板保鲜窗口（小时）。REDTEAM_TEMPLATE_REFRESH_HOURS=0 关闭自动刷新。 */
function templateRefreshHours(env = process.env) {
  const raw = Number(env.REDTEAM_TEMPLATE_REFRESH_HOURS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return 72
}

/** 当前模板库的"年龄"（小时）；没有记录返回 null。 */
function templatesAgeHours(cfg) {
  const at = Number(cfg && cfg.templatesRefreshedAt) || 0
  if (at <= 0) return null
  return (Date.now() - at) / 3600000
}

/** 模板库状态：给 preflight / poc_search / 面板共用的一份口径。 */
export function templatesStatus(root = redteamRoot()) {
  const cfg = loadPlatformConfig(root)
  const dir = (cfg.nucleiTemplatesDir && looksLikeTemplates(cfg.nucleiTemplatesDir))
    ? cfg.nucleiTemplatesDir
    : (looksLikeTemplates(join(root, 'toolkit', 'nuclei-templates')) ? join(root, 'toolkit', 'nuclei-templates') : '')
  const age = templatesAgeHours(cfg)
  const limit = templateRefreshHours()
  /* config 里的 count 只有"刷新过"才有；老机器（装完没刷过）会是 0，
     这时按磁盘实count一次，否则 preflight 会把 1.4 万个模板报成 0 个。 */
  const stored = Number(cfg.templatesCount) || 0
  const count = stored > 0 ? stored : (dir ? countYaml(dir, 20000) : 0)
  return {
    dir: dir || null,
    count,
    refreshed_at: Number(cfg.templatesRefreshedAt) || 0,
    age_hours: age === null ? null : Math.round(age * 10) / 10,
    /* 有库但从没刷新过 = 也是过期（老机器装完就没动过）；没有库不谈过期 */
    stale: age === null ? (dir !== '') : (limit > 0 && age >= limit),
    auto_refresh_hours: limit,
    owned: ownsTemplatesDir(dir, root),
    last_error: String(cfg.templatesLastError || ''),
  }
}
function innerTemplatesDir(extracted) {
  if (looksLikeTemplates(extracted)) return extracted
  let entries = []
  try { entries = readdirSync(extracted, { withFileTypes: true }) } catch { return '' }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const next = join(extracted, entry.name)
    if (looksLikeTemplates(next)) return next
  }
  return ''
}

function tryLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true })
  try {
    if (existsSync(lockPath)) {
      const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (Date.now() - Number(raw.at || 0) < 10 * 60 * 1000) return false
      unlinkSync(lockPath)
    }
  } catch {
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath) } catch { /* ignore */ }
}

function downloadFile(url, dest, timeoutMs) {
  return new Promise((resolve, reject) => {
    const visit = (target, hops) => {
      if (hops > 6) {
        reject(new Error('redirect'))
        return
      }
      const lib = target.startsWith('http:') ? http : https
      const req = lib.get(target, {
        headers: { 'User-Agent': 'pi-purge-redteam' },
      }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          visit(new URL(res.headers.location, target).href, hops + 1)
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error('HTTP ' + code))
          return
        }
        const out = createWriteStream(dest)
        res.pipe(out)
        out.on('finish', () => resolve(dest))
        out.on('error', reject)
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('timeout'))
      })
      req.on('error', reject)
    }
    visit(url, 0)
  })
}

function runHidden(file, args, timeoutMs, extra = {}) {
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: timeoutMs,
    ...extra,
  })
}

function gitCloneTemplates(url, dest, timeoutMs) {
  const staging = join(tmpdir(), 'pi-purge-nuclei-git-' + process.pid)
  rmSync(staging, { recursive: true, force: true })
  runHidden('git', [
    'clone', '--depth', '1', '--single-branch', '--branch', 'main', url, staging,
  ], timeoutMs, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  const inner = innerTemplatesDir(staging)
  if (!inner) throw new Error('git clone 里没有模板')
  moveDir(inner, dest)
  if (inner !== staging) rmSync(staging, { recursive: true, force: true })
  if (!looksLikeTemplates(dest)) throw new Error('git clone 不完整')
  return dest
}

function extractArchive(archive, dest, timeoutMs, gzip) {
  mkdirSync(dest, { recursive: true })
  try {
    runHidden('tar', gzip ? ['-xzf', archive, '-C', dest] : ['-xf', archive, '-C', dest], timeoutMs)
    return 'tar'
  } catch {
    if (!gzip) {
      try {
        runHidden(
          'powershell',
          ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:DSH_UPD_ZIP -DestinationPath $env:DSH_UPD_DIR -Force'],
          timeoutMs,
          { env: { ...process.env, DSH_UPD_ZIP: archive, DSH_UPD_DIR: dest } },
        )
        return 'powershell'
      } catch { /* fallback below */ }
      extractZipArchive(archive, dest)
      return 'node'
    }
    throw new Error('tar 解压失败')
  }
}

async function downloadAndExtract(url, dest, timeoutMs, kind) {
  const archive = join(tmpdir(), 'pi-purge-nuclei-templates.' + (kind === 'tgz' ? 'tgz' : 'zip'))
  const staging = join(tmpdir(), 'pi-purge-nuclei-' + kind + '-' + process.pid)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  await downloadFile(url, archive, timeoutMs)
  extractArchive(archive, staging, timeoutMs, kind === 'tgz')
  const inner = innerTemplatesDir(staging)
  if (!inner) throw new Error(kind + ' 里没有模板')
  moveDir(inner, dest)
  if (inner !== staging) rmSync(staging, { recursive: true, force: true })
  try { unlinkSync(archive) } catch { /* ignore */ }
  if (!looksLikeTemplates(dest)) throw new Error('解压后模板不完整')
  return dest
}

async function pullTemplates(dest, timeoutMs, root) {
  if (looksLikeTemplates(dest)) return dest
  mkdirSync(join(dest, '..'), { recursive: true })
  const started = Date.now()
  const left = () => Math.max(0, timeoutMs - (Date.now() - started))
  let last = ''
  const slice = () => Math.min(90000, left())
  for (const url of GIT_URLS) {
    if (left() < 12000) break
    try {
      logLine(root, 'git clone ' + url)
      return gitCloneTemplates(url, dest, slice())
    } catch (error) {
      last = String(error && error.message ? error.message : error)
      logLine(root, 'git fail: ' + last)
    }
  }
  for (const url of TAR_URLS) {
    if (left() < 12000) break
    try {
      logLine(root, 'tgz ' + url)
      return await downloadAndExtract(url, dest, slice(), 'tgz')
    } catch (error) {
      last = String(error && error.message ? error.message : error)
      logLine(root, 'tgz fail: ' + last)
    }
  }
  for (const url of ZIP_URLS) {
    if (left() < 12000) break
    try {
      logLine(root, 'zip ' + url)
      return await downloadAndExtract(url, dest, slice(), 'zip')
    } catch (error) {
      last = String(error && error.message ? error.message : error)
      logLine(root, 'zip fail: ' + last)
    }
  }
  throw new Error(last || '模板下载失败')
}

/**
 * 取（或刷新）模板库。
 *  - refresh=false：已有库直接返回（现状行为，首次安装用）；
 *  - refresh=true ：下到 staging，数量对得上才整目录换掉；对不上就保留旧库并抛错。
 */
async function fetchTemplates(dest, timeoutMs, root, options = {}) {
  const refreshMode = options.refresh === true
  const had = looksLikeTemplates(dest)
  if (had && !refreshMode) return { dir: dest, action: 'kept', count: countYaml(dest, 100000) }
  const staging = join(dirname(dest), '.nuclei-staging-' + process.pid + '-' + Date.now())
  rmSync(staging, { recursive: true, force: true })
  try {
    /* 现有三段回退链（git → tar → zip）原样复用：目的地是 staging，不是线上库 */
    const got = await pullTemplates(staging, timeoutMs, root)
    if (!looksLikeTemplates(got)) throw new Error('下载结果里没有模板')
    const before = had ? countYaml(dest, 100000) : 0
    const after = countYaml(got, 100000)
    if (had && before > 0 && after < before * 0.9) {
      throw new Error('刷新结果异常（' + after + ' < ' + before + '×0.9），保留旧库')
    }
    swapDir(got, dest)
    return { dir: dest, action: had ? 'refreshed' : 'installed', count: after }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 启动时按龄刷新：只动自己那份库，只在自己拿得到锁时动，失败只记日志。
 * 返回 { action } —— kept / refreshed / skipped(disabled|fresh|no-templates|not-owned|locked)。
 */
export async function refreshTemplatesIfStale(options = {}) {
  const hours = templateRefreshHours()
  if (hours === 0) return { action: 'skipped', reason: 'disabled' }
  const homes = collectHomes()
  const primaryRoot = join(homes[0], 'redteam')
  const cfg = loadPlatformConfig(primaryRoot)
  const status = templatesStatus(primaryRoot)
  if (!status.dir) return { action: 'skipped', reason: 'no-templates' }
  if (!status.owned) return { action: 'skipped', reason: 'not-owned', dir: status.dir }
  const age = templatesAgeHours(cfg)
  if (age !== null && age < hours) return { action: 'skipped', reason: 'fresh', age_hours: Math.round(age * 10) / 10 }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000
  const lockPath = join(primaryRoot, 'toolkit', '.nuclei-templates.lock')
  if (!tryLock(lockPath)) return { action: 'skipped', reason: 'locked' }
  try {
    logLine(primaryRoot, 'templates refresh start')
    const out = await fetchTemplates(status.dir, timeoutMs, primaryRoot, { refresh: true })
    savePlatformConfig({
      templatesRefreshedAt: Date.now(),
      templatesCount: out.count,
      templatesCommit: gitHeadOf(out.dir),
      templatesLastError: '',
    }, primaryRoot)
    /* 内容变了，检索缓存必须作废（路径没变，writeConfig 的早退删不掉它） */
    try { unlinkSync(join(primaryRoot, 'pocs', '.nuclei-index.json')) } catch { /* ignore */ }
    logLine(primaryRoot, 'templates refresh done count=' + out.count)
    return out
  } catch (error) {
    const msg = String(error && error.message ? error.message : error)
    logLine(primaryRoot, 'templates refresh fail: ' + msg)
    try { savePlatformConfig({ templatesLastError: msg }, primaryRoot) } catch { /* ignore */ }
    return { action: 'failed', error: msg }
  } finally {
    releaseLock(lockPath)
  }
}

/**
 * 手动刷新（工具 redteam_template_refresh / 面板按钮共用）。
 * force=false 时按龄节流；true 时无条件重下。全程 try/catch，绝不抛到调用方。
 */
export async function refreshTemplateLibrary(options = {}) {
  const homes = collectHomes()
  const primaryRoot = join(homes[0], 'redteam')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000
  const before = templatesStatus(primaryRoot)
  if (!before.dir) return { action: 'skipped', reason: 'no-templates', status: before }
  if (!before.owned) return { action: 'skipped', reason: 'not-owned', status: before }
  if (options.force !== true) {
    const out = await refreshTemplatesIfStale({ timeoutMs })
    return Object.assign({ status: templatesStatus(primaryRoot) }, out)
  }
  const lockPath = join(primaryRoot, 'toolkit', '.nuclei-templates.lock')
  if (!tryLock(lockPath)) return { action: 'skipped', reason: 'locked', status: before }
  try {
    const out = await fetchTemplates(before.dir, timeoutMs, primaryRoot, { refresh: true })
    savePlatformConfig({
      templatesRefreshedAt: Date.now(),
      templatesCount: out.count,
      templatesCommit: gitHeadOf(out.dir),
      templatesLastError: '',
    }, primaryRoot)
    try { unlinkSync(join(primaryRoot, 'pocs', '.nuclei-index.json')) } catch { /* ignore */ }
    logLine(primaryRoot, 'templates manual refresh done count=' + out.count)
    return Object.assign({ action: out.action }, out, { status: templatesStatus(primaryRoot) })
  } catch (error) {
    const msg = String(error && error.message ? error.message : error)
    logLine(primaryRoot, 'templates manual refresh fail: ' + msg)
    try { savePlatformConfig({ templatesLastError: msg }, primaryRoot) } catch { /* ignore */ }
    return { action: 'failed', error: msg, status: templatesStatus(primaryRoot) }
  } finally {
    releaseLock(lockPath)
  }
}
/** git 分支的 HEAD（没有 git / 不是 git 库就返回空串，只作溯源展示）。 */
function gitHeadOf(dir) {
  try {
    return String(execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }) || '').trim()
  } catch { return '' }
}
async function waitForTemplates(dest, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (looksLikeTemplates(dest)) return dest
    await sleep(1500)
  }
  throw new Error('等待模板超时')
}

function seedKnowledge(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'pocs'), { recursive: true })
  mkdirSync(join(root, 'toolkit'), { recursive: true })
  const db = new DatabaseSync(join(root, 'knowledge.db'))
  try {
    db.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL)
    migrateKnowledge(db)
    return Number(db.prepare('SELECT COUNT(*) AS n FROM poc').get()?.n ?? 0)
  } finally {
    db.close()
  }
}

function writeConfig(root, templatesDir) {
  const prev = loadPlatformConfig(root)
  const toolkit = prev.toolkitDir && existsSync(prev.toolkitDir) ? prev.toolkitDir : join(root, 'toolkit')
  mkdirSync(toolkit, { recursive: true })
  const tools = Object.assign({}, prev.tools || {})
  for (const [id, path] of Object.entries(tools)) {
    if (path && !existsSync(path)) tools[id] = ''
  }
  let assigned = {}
  try {
    assigned = scanFolderForTools(toolkit).assigned || {}
  } catch { assigned = {} }
  for (const [id, path] of Object.entries(assigned)) {
    if (path && existsSync(path) && !tools[id]) tools[id] = path
  }
  try {
    for (const item of resolveAllTools({ root, config: Object.assign({}, prev, { toolkitDir: toolkit, tools }) })) {
      if (item.path && existsSync(item.path) && !tools[item.id]) tools[item.id] = item.path
    }
  } catch { /* PATH 扫描失败不挡 */ }
  const keptNuclei = looksLikeTemplates(prev.nucleiTemplatesDir) ? prev.nucleiTemplatesDir : ''
  const nuclei = keptNuclei
    || (looksLikeTemplates(templatesDir) ? templatesDir : (prev.nucleiTemplatesDir || ''))
  const foundAny = Object.values(tools).some((path) => path && existsSync(path))
  savePlatformConfig({
    toolkitDir: toolkit,
    nucleiTemplatesDir: nuclei,
    tools,
    envAdaptConfigured: true,
    envAdaptSkip: prev.envAdaptSkip || !foundAny,
  }, root)
  if (keptNuclei) return
  try { unlinkSync(join(root, 'pocs', '.nuclei-index.json')) } catch { /* 下次检索重建 */ }
}

/**
 * @param options {{ download?: boolean, background?: boolean, timeoutMs?: number }}
 */
export async function ensureRedteamRuntime(options = {}) {
  const download = options.download !== false
  const background = options.background === true
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 180000
  const homes = collectHomes()
  const primaryHome = homes[0]
  const primaryRoot = join(primaryHome, 'redteam')
  mkdirSync(primaryRoot, { recursive: true })
  logLine(primaryRoot, 'ensure start download=' + download + ' background=' + background)

  let pocs = 0
  try { pocs = seedKnowledge(primaryRoot) } catch (error) {
    logLine(primaryRoot, 'kb fail: ' + String(error && error.message ? error.message : error))
  }

  let templatesDir = discoverTemplates(homes)
  let templatesDownloaded = false
  let templatesError = ''
  const dest = templatesDir || join(primaryRoot, 'toolkit', 'nuclei-templates')
  const lockPath = join(primaryRoot, 'toolkit', '.nuclei-templates.lock')

  if (!looksLikeTemplates(dest) && download) {
    const runPull = async () => {
      const got = await pullTemplates(dest, timeoutMs, primaryRoot)
      logLine(primaryRoot, 'templates ready ' + got)
      return got
    }
    if (background) {
      templatesDir = dest
      templatesError = 'downloading'
      void (async () => {
        if (!tryLock(lockPath)) return
        try { await runPull() } catch (error) {
          logLine(primaryRoot, 'bg fail: ' + String(error && error.message ? error.message : error))
        } finally {
          releaseLock(lockPath)
          try { writeConfig(primaryRoot, dest) } catch { /* ignore */ }
        }
      })()
    } else if (!tryLock(lockPath)) {
      try {
        templatesDir = await waitForTemplates(dest, timeoutMs)
      } catch (error) {
        templatesError = String(error && error.message ? error.message : error)
        templatesDir = dest
      }
    } else {
      try {
        templatesDir = await runPull()
        templatesDownloaded = looksLikeTemplates(templatesDir)
      } catch (error) {
        templatesError = String(error && error.message ? error.message : error)
        templatesDir = dest
        logLine(primaryRoot, 'pull fail: ' + templatesError)
      } finally {
        releaseLock(lockPath)
      }
    }
  }

  for (const home of homes) {
    const root = join(home, 'redteam')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'toolkit'), { recursive: true })
    mkdirSync(join(root, 'pocs'), { recursive: true })
    if (root !== primaryRoot) {
      try { seedKnowledge(root) } catch { /* ignore */ }
    }
    try { writeConfig(root, templatesDir) } catch (error) {
      logLine(primaryRoot, 'config fail ' + root + ': ' + String(error && error.message ? error.message : error))
    }
  }

  /* 首次装好就记一次时间戳，否则第一次自动刷新判断会永远是"没有记录" */
  if (looksLikeTemplates(templatesDir)) {
    const cfgNow = loadPlatformConfig(primaryRoot)
    if (!Number(cfgNow.templatesRefreshedAt)) {
      try {
        savePlatformConfig({
          templatesRefreshedAt: Date.now(),
          templatesCount: countYaml(templatesDir, 100000),
          templatesCommit: gitHeadOf(templatesDir),
        }, primaryRoot)
      } catch { /* 写不进去不挡 */ }
    }
  }

  /* 按龄刷新：后台跑，失败只进 bootstrap.log。没有模板 / 不是自己那份 / 关闭都直接跳过。
     `download:false` 的调用方（例如"应用清洗"这类不该联网的路径）一律不触发刷新。 */
  if (looksLikeTemplates(templatesDir)) {
    const kick = () => {
      void refreshTemplatesIfStale({ timeoutMs }).then((out) => {
        logLine(primaryRoot, 'templates auto refresh ' + out.action + (out.reason ? '/' + out.reason : ''))
      }).catch(() => { /* refreshTemplatesIfStale 自己吞错，这里只是兜底 */ })
    }
    if (background && download) {
      try {
        kick()
        /* 公告层跟模板一个后台 kick：它不在"刷新成功"路径里，单独跑，互不牵连 */
        void refreshKevIfStale({ root: primaryRoot }).then((out) => {
          logLine(primaryRoot, 'kev refresh ' + out.action + (out.reason ? '/' + out.reason : ''))
        }).catch(() => { /* 公告层自己吞错 */ })
      } catch { /* ignore */ }
    }
  }
  const report = {
    root: primaryRoot,
    knowledgePath: join(primaryRoot, 'knowledge.db'),
    pocs,
    templatesDir,
    templates: countYaml(templatesDir, 500),
    templatesDownloaded,
    templatesError,
    templatesStatus: templatesStatus(primaryRoot),
    kev: kevStatus(primaryRoot),
  }
  logLine(primaryRoot, 'ensure done templates=' + report.templates + ' err=' + (templatesError || 'none'))
  return report
}
