/**
 * RedTeam 控制台 —— Host 半侧
 *
 * 职责：为浏览器半侧提供一条 Package 私有的 HTTP 桥接 `POST /redteam/api`：
 *   · 资产库相关 op 转交 `ctx.redteam`（dsh-redteam-store 发布的进程级服务）；
 *   · 会话连通性 op（probeSessions）在 host 侧真实发起 TCP/HTTP 探测；
 *   · 技能目录 op（skillCatalog / skillRead）直接读 `ctx.skills`，按红队 preset
 *     的 standing scope 取目录——技能由 DSH 原生 skill 体系管理（$DSH_HOME/skills、
 *     项目 .dsh/skills、.agents/skills），控制台只做浏览。
 *
 * 为什么走 webServer 而不是 typert/@Remote：本包与 store 包都刻意保持零外部依赖
 * （profile 下解析不到 node_modules），具名路由是最小且稳定的接缝。
 * 跨源请求由 Origin/Host 校验挡住（同源 POST 才放行）。
 */
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { dispatch, dispatchAsync } from './store-core.js'
/* 技能可用性判定与 redteam_preflight 共用同一份实现（环境变量 / 本机路径 / 占位符） */
import { checkSkill, officialSkillSummaries, skillLibraryOf, summarizeSkills } from './skill-availability.js'
import { maxAgentsOf, maxAgentsSourceOf, saveMaxAgents, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
/* 名额挂起状态与工具层共用一份（tools.js 写、这里读） */
import { isParked } from './slot-state.js'
import {
  loadPlatformConfig, mergeConfigEnv, redteamRoot, envAdaptStatus, markEnvAdaptSkip,
  platformSummary, savePlatformConfig, assignToolkitFolder,
} from './platform-config.js'

/**
 * 沿 `parentSession` 走到根会话 id（最多 64 层，防环）。
 *
 * 面板「跟随会话」需要它：host 侧绑定表只记**根会话**键，但用户在界面里点开的
 * 可能是子智能体的会话。
 *
 * @param ctx - 插件上下文（读 sessions 注册表；不可用时返回原 id）。
 * @param sessionId - 任意会话 id。
 * @returns 根会话 id（解析不了就原样返回）。
 */
export function resolveRootSessionId(ctx, sessionId) {
  const id = String(sessionId || '')
  if (!id) return id
  let sessions = null
  try { sessions = ctx.get('sessions') } catch { sessions = null }
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return id
  let list = []
  try { list = sessions.list() } catch { return id }
  const byId = new Map()
  for (const s of Array.isArray(list) ? list : []) {
    const sid = s && s.id !== undefined ? String(s.id) : ''
    if (sid) byId.set(sid, s)
  }
  let cur = id
  let lastKnown = id
  for (let guard = 0; guard < 64; guard += 1) {
    const node = byId.get(cur)
    if (node === undefined) {
      return byId.has(id) ? lastKnown : cur
    }
    lastKnown = cur
    const header = node.header
    const parent = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : ''
    if (!parent) return cur
    if (parent === cur) return cur
    cur = parent
  }
  return cur
}

/** DSH_HOME：显式环境变量优先；Windows 上 HOME 常空，回退 homedir()。 */
function dshHomeOf() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/**
 * 本包自带技能目录候选。
 * 桌面端经 profile/node_modules 符号链接加载时，单靠 import.meta.url 拼相对路径
 * 可能指到不存在的位置（空格路径、未解析的 junction）；所以多路探测并 realpath。
 * 不从 index.js 引 packagePaths，避免与 cordis 插件入口互相拖拽。
 */
/** `$DSH_HOME` 的两个可能来源（插件进程 env 与宿主 dshHomePath 用的 home 会分叉）。 */
function dshHomeCandidates() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  return out
}

function resolvePluginSkillsDir() {
  const candidates = []
  try {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    candidates.push(join(root, 'skills', 'redteam'))
  } catch { /* ignore */ }
  try {
    candidates.push(resolve(fileURLToPath(new URL('../../skills/redteam/', import.meta.url))))
  } catch { /* ignore */ }
  /* installBundledSkills 落盘位置：包内路径失效时仍能列出技能。两个候选 home 都探。 */
  for (const home of dshHomeCandidates()) {
    candidates.push(join(home, 'redteam', 'skills'))
    for (const profile of ['desktop', 'web', 'headless']) {
      candidates.push(join(home, 'profiles', profile, 'node_modules', 'pi-purge', 'skills', 'redteam'))
    }
  }
  /* 不扫官方 $DSH_HOME/skills：技能只认本包 / 同步副本（与上游插件包内分发一致）。 */
  for (const raw of candidates) {
    if (!raw) continue
    try {
      if (!existsSync(raw)) continue
      const real = realpathSync(raw)
      const md = readdirSync(real).filter((f) => f.endsWith('.md'))
      if (md.length > 0 || /skills[/\\]redteam$/i.test(real) || /[/\\]skills$/i.test(real)) return real
    } catch { /* try next */ }
  }
  return null
}

const PLUGIN_SKILLS_DIR = resolvePluginSkillsDir()

function readOfficialSkill(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'name required' }
  const found = officialSkillSummaries().find((skill) => skill.name === name)
  if (!found) return { ok: false, error: 'skill not found: ' + name }
  return {
    ok: true,
    name: found.name,
    description: found.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    path: found.path,
    content: found.content,
    library: 'official',
  }
}

function officialCatalogItems() {
  return officialSkillSummaries().map((skill) => ({
    name: skill.name,
    description: skill.description,
    whenToUse: '',
    provider: 'dsh',
    source: 'official',
    dir: skill.resourceBase && skill.resourceBase.path,
    path: skill.path,
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: false,
    library: 'official',
    availability: 'listed',
    problems: [],
    needs_user: [],
  }))
}

function withBothLibraries(payload) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const redteam = payload.items.map((item) => Object.assign({ library: 'redteam' }, item, {
    library: item.library === 'official' ? 'official' : 'redteam',
  }))
  const seen = new Set(redteam.filter((item) => item.library === 'official').map((item) => item.name))
  const official = officialCatalogItems().filter((item) => !seen.has(item.name))
  const items = redteam.concat(official)
  return Object.assign({}, payload, {
    items,
    total: items.length,
    libraries: {
      redteam: items.filter((item) => item.library !== 'official').length,
      official: items.filter((item) => item.library === 'official').length,
    },
  })
}
/** 目录比较要规范化：注册表给的是 `/a/b/skills`，URL 拼出来可能带结尾斜杠。 */
const sameDir = (a, b) => {
  if (a === null || b === null) return false
  try {
    const left = existsSync(a) ? realpathSync(a) : resolve(a)
    const right = existsSync(b) ? realpathSync(b) : resolve(b)
    return left === right
  } catch {
    try { return resolve(a) === resolve(b) } catch { return false }
  }
}

/** Cordis 插件名。 */
export const name = 'pi-purge-redteam-ui'

/**
 * 硬依赖只留资产库 + HTTP。
 * skills / agentPresets 在桌面端时常序更晚或名称不同；写成硬依赖会导致整条
 * `/redteam/api` 挂不上，界面里技能库/知识库/SQLite 全部读不到。
 */
export const inject = ['redteam', 'webServer']

/** 请求体上限（资产导入可能较大）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/* ------------------------------------------------------------------ 版本与更新 */

/** 运行 shell 命令，带超时；返回 `{ code, stdout, stderr, timedOut }`。 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      /* ⚠️ 三个都踩过：
         · env 必须显式传 process.env —— spawn 默认给的是空环境，空 PATH 下
           npm/pnpm 会直接 `spawn npm ENOENT`（版本检查永远失败）；
         · cwd 必须是**真实存在**的目录 —— 传一个不存在的路径同样是 ENOENT
           （报错长得像"命令找不到"，很容易误判）；
         · Windows 上 npm/npx/pnpm/yarn 都是 .cmd 批处理，Node 的 spawn 不走
           shell 时直接找不到可执行文件 —— 必须 `shell: true`（或补 .cmd 后缀）
           才能解析 PATHEXT，不然红队面板「检测新版本」永远 code=-1。 */
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd) ? options.cwd : undefined
      const isWin = process.platform === 'win32'
      const needsShim = isWin && /^(npm|npx|pnpm|pnpx|yarn)$/i.test(command)
      child = spawn(needsShim ? `${command}.cmd` : command, args, {
        cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: needsShim,
        windowsHide: isWin,
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const CHILD_IO_CAP = 1 << 20 // 子进程 stdout/stderr 各 1MB 上限,防失控子进程 OOM 宿主
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const cleanupPipes = () => {
      try { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } catch { /* ignore */ }
      try { child.stdout.destroy(); child.stderr.destroy() } catch { /* ignore */ }
    }
    // kill 子孙:child.kill 只杀直接子,孙子(npm → node → tool)活着。Windows 用 taskkill /T 杀树,
    // POSIX 兜底 SIGKILL + 尝试 process group kill。
    const killTree = () => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
            stdio: 'ignore', windowsHide: true, timeout: 2000,
          })
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* 不是 group leader,忽略 */ }
        }
      } catch { /* taskkill 失败也无所谓,child.kill 已先触发 */ }
    }
    const timer = setTimeout(() => {
      killTree()
      cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: stderr, timedOut: true })
    }, Math.max(Number(options.timeoutMs) || 30000, 1000))
    child.stdout.on('data', (c) => {
      if (settled) return
      if (stdout.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stdout' }); return
      }
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c) => {
      if (settled) return
      if (stderr.length + c.length > CHILD_IO_CAP) {
        killTree()
        clearTimeout(timer); cleanupPipes()
        done({ code: -1, stdout, stderr, oversize: 'stderr' }); return
      }
      stderr += c.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: -1, stdout: stdout, stderr: String((error && error.message) || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer); cleanupPipes()
      done({ code: code === null ? -1 : code, stdout: stdout, stderr: stderr })
    })
  })
}

/** 本插件包身份（由 store 壳读取 package.json 后挂上；读不到则报"未知版本"）。 */
function pluginIdentity(ctx) {
  const store = ctx.redteam
  const info = store && store.plugin ? store.plugin : null
  return {
    name: (info && info.name) || 'pi-purge',
    version: (info && info.version) || null,
    description: (info && info.description) || '',
    homepage: (info && info.homepage) || null,
  }
}

/**
 * profile 目录：DSH 的 `ctx.baseUrl` 就是它（loader.internal.import(name, profileDir) 的 base）。
 * ⚠️ `ctx.baseUrl` 实际是 `file:///...` URL —— 直接当路径传给 join/existsSync 会把
 *    `node_modules` 拼到 URL 后面，`updatePreflight` 把 `devLinked` 永久判成 true，
 *    之后面板的「更新」按钮永远灰着。必须 fileURLToPath 转回系统路径。
 */
function profileDirOf(ctx) {
  try {
    const raw = ctx && typeof ctx.baseUrl === 'string' ? ctx.baseUrl : ''
    if (raw) return raw.startsWith('file://') ? fileURLToPath(raw) : raw
  } catch { /* 忽略：转换失败走兜底路径 */ }
  return join(dshHomeOf(), 'profiles', 'web')
}

/**
 * 环境适配 op：面板 EnvTab 读写 `$DSH_HOME/redteam/config.json`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
function handlePlatformOp(store, request) {
  const op = request && request.op
  if (op !== 'platformConfigGet' && op !== 'platformConfigSave' && op !== 'platformAssignToolkit'
    && op !== 'platformEnvAdaptStatus' && op !== 'platformEnvAdaptSkip') {
    return undefined
  }
  const root = (store && store.root) || redteamRoot()
  // EnvAdaptSendGate 轮询就绪 / 「暂不配置」；缺分支时前端永远拿不到 ready。
  if (op === 'platformEnvAdaptStatus') return Object.assign({ ok: true }, envAdaptStatus(root))
  if (op === 'platformEnvAdaptSkip') {
    return Object.assign({ ok: true }, markEnvAdaptSkip(root, request.skip === undefined ? true : !!request.skip))
  }
  if (op === 'platformConfigGet') return platformSummary(root)
  if (op === 'platformConfigSave') {
    savePlatformConfig(request.config || {}, root)
    return platformSummary(root)
  }
  return assignToolkitFolder(request.dir, root)
}

/** 读 profile 的 package.json（依赖声明 + dsh.profile.bundles）。 */
function readProfilePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return null }
}

/** 包管理器：profile 里有 pnpm-lock / pnpm-workspace 就用 pnpm，否则 npm。 */
function packageManagerOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  return 'npm'
}



/** 读取完整请求体；超过上限即中断。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // destroy 带 Error → socket 立即 RST,client 不会继续发,端对端收尾。
        const err = new Error('request body too large')
        done(reject, err)
        try { req.destroy(err) } catch { /* 忽略 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => done(reject, err))
  })
}

/** 统一的 JSON 响应。 */
/** 本机网卡地址集合（含回环/`::ffff:` 映射）。用来判断"这条连接是不是本机自己发的"。 */
function selfAddressSet() {
  const norm = (a) => String(a || '').replace(/^::ffff:/i, '')
  const set = new Set(['127.0.0.1', '::1', '::', '0.0.0.0'])
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const it of list || []) {
        if (it && it.address) set.add(norm(it.address))
      }
    }
  } catch { /* 取不到网卡就只认回环 */ }
  return { has: (a) => set.has(norm(a)) }
}

/** 桌面端 webview 的来源：自定义协议 / 本地文件 / 扩展页，host 比较无意义。 */
const APP_ORIGIN_RE = /^(app|file|blob|data|about|chrome-extension|moz-extension|ms-browser-extension|tauri|capacitor|ionic):/i

/** 403 时记一条，方便下回直接看是哪条来源被判掉（不记录 body，不记录 cookie）。 */
function logCorsReject(req, detail) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(home, 'redteam')
    mkdirSync(dir, { recursive: true })
    const line = [new Date().toISOString(), detail.path || '', 'remote=' + detail.remote,
      'host=' + detail.host, 'origin=' + (detail.origin === undefined ? '(none)' : String(detail.origin)),
      'site=' + (detail.site || '')].join('\t')
    writeFileSync(join(dir, 'cors-reject.log'), line + '\n', { encoding: 'utf8', flag: 'a' })
  } catch { /* 记日志失败不影响拒绝 */ }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 技能可用性缓存：`{ at, scope, byName: Map }`；30 秒内复用。 */
let skillAvailabilityCache = null
const SKILL_AVAILABILITY_TTL_MS = 30000

/**
 * 安全取 Cordis 服务：未 inject 时 ctx.get / 点属性都会抛，不能让它冒泡成 400。
 */
function softService(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch { /* not injected */ }
  try {
    return ctx[name]
  } catch { /* proxy throw */ }
  return undefined
}

/**
 * 逐个技能的可用性（读正文 → 共享判定模块）。
 * @param skillsSvc - 已取得的 skills 服务（可为 null）。
 * @param list - `skills.list()` 的返回（SkillSummary[]）。
 * @param scope - 当前作用域。
 * @param force - true 时跳过快取缓存。
 */
async function skillAvailabilityOf(skillsSvc, list, scope, force) {
  const now = Date.now()
  // scope 签名加入 cache key:切预设时 scope 变,老 cache 可能对应错误的技能可用性快照。
  const scopeSig = scope == null ? '' : String(scope)
  if (!force && skillAvailabilityCache !== null
    && now - skillAvailabilityCache.at < SKILL_AVAILABILITY_TTL_MS
    && skillAvailabilityCache.size === list.length
    && skillAvailabilityCache.scope === scopeSig) {
    return { at: skillAvailabilityCache.at, cached: true, byName: skillAvailabilityCache.byName }
  }
  const rootsWith = new Map()
  for (const x of list) {
    const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
    if (dir === null) continue
    if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
    if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
  }
  const byName = new Map()
  for (const summary of list) {
    let def
    try {
      def = skillsSvc && typeof skillsSvc.get === 'function'
        ? await skillsSvc.get(summary.name, { scope })
        : undefined
    } catch { def = undefined }
    const path = def && typeof def.path === 'string'
      ? def.path
      : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
    const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
    const verdict = checkSkill({ name: summary.name, content: def && def.content, path, root },
      { env: mergeConfigEnv(process.env, loadPlatformConfig(redteamRoot())), sameNameIn: rootsWith.get(summary.name) || [] })
    byName.set(summary.name, verdict)
  }
  skillAvailabilityCache = { at: now, scope: scope == null ? '' : String(scope), size: list.length, byName }
  return { at: now, cached: false, byName }
}

/**
 * 技能目录：桌面端默认读本包 `skills/redteam/*.md`；
 * 仅当 skills + agentPresets 都可用时才走原生注册表。
 */
async function handleSkillOp(ctx, request) {
  if (request.op !== 'skillCatalog' && request.op !== 'skillRead') return undefined

  /* 桌面端绝不能让 "without inject" 冒泡：一律 softService + 文件兜底。 */
  const skillsSvc = softService(ctx, 'skills')
  const presetsSvc = softService(ctx, 'agentPresets')

  let scope = null
  let registryReady = false
  if (skillsSvc && typeof skillsSvc.list === 'function' && presetsSvc) {
    const standing = presetsSvc.standingKeyFor
    if (typeof standing === 'function') {
      try {
        scope = await standing.call(presetsSvc, 'redteam')
        registryReady = scope != null
      } catch {
        registryReady = false
      }
    }
  }

  if (!registryReady) {
    return withBothLibraries(handleSkillOpFromPluginDir(request))
  }

  if (request.op === 'skillCatalog') {
    let list = []
    try {
      list = await skillsSvc.list({ scope })
    } catch {
      list = []
    }
    if (!Array.isArray(list) || list.length === 0) {
      return withBothLibraries(handleSkillOpFromPluginDir(request))
    }
    const redteamList = list.filter((s) => skillLibraryOf(s) !== 'official')
    const availability = await skillAvailabilityOf(skillsSvc, redteamList, scope, request.refresh === true)
    const pluginDir = resolvePluginSkillsDir()
    const bySource = new Map()
    const byDir = new Map()
    const items = list.map((s) => {
      const dir = s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : null
      const name = dir === null ? '(非文件系统来源)' : dir
      byDir.set(name, (byDir.get(name) || 0) + 1)
      bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
      const library = skillLibraryOf(s) === 'official' ? 'official' : 'redteam'
      const avail = availability.byName.get(s.name)
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        category: s.category || '',
        provider: s.provider,
        source: s.source,
        dir: dir,
        modelInvocable: s.invocation ? s.invocation.modelInvocable !== false : true,
        userInvocable: s.invocation ? s.invocation.userInvocable !== false : true,
        fromPlugin: sameDir(dir, pluginDir),
        library,
        availability: library === 'official' ? 'listed' : (avail ? avail.status : 'unknown'),
        problems: library === 'official' ? [] : (avail ? avail.problems : ['未检查']),
        needs_user: library === 'official' ? [] : (avail ? avail.needs_user : []),
      }
    })
    const availSummary = summarizeSkills(Array.from(availability.byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.filter((x) => x.fromPlugin).length,
      availability: {
        summary: availSummary,
        checked_at: availability.at,
        cached: availability.cached,
        broken: Array.from(availability.byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '可用性 = 技能文件存在且正文能加载。缺工具、缺密钥、VPS 占位符记在缺口里，不把整条技能标成不可用。',
      },
      bySource: Array.from(bySource, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      byDir: Array.from(byDir, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      note: '红队技能和官方技能分开。红队技能才做工具路径检查；官方技能在 $DSH_HOME/skills，由宿主按任务调用。',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  try {
    const skill = await skillsSvc.get(request.name, { scope })
    if (skill !== undefined) {
      return {
        ok: true,
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse || '',
        category: skill.category || '',
        provider: skill.provider,
        source: skill.source,
        path: skill.path || null,
        content: skill.content || '',
      }
    }
  } catch { /* fall through */ }
  return handleSkillOpFromPluginDir(request)
}

/** 从本包 skills/redteam 目录拼一份技能目录，并做真实可用性检查（不依赖宿主 skills 注入）。 */
function handleSkillOpFromPluginDir(request) {
  const dir = resolvePluginSkillsDir() || PLUGIN_SKILLS_DIR
  if (!dir || !existsSync(dir)) {
    return { ok: false, error: '本包 skills/redteam 目录不存在，且宿主 skills 服务不可用' }
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  const parseMeta = (text) => {
    const out = { description: '', whenToUse: '', category: '' }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) {
      const first = String(text || '').split(/\r?\n/).find((l) => l.trim()) || ''
      out.description = first.replace(/^#\s*/, '').trim()
      return out
    }
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      if (kv[1] === 'description') out.description = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (kv[1] === 'when_to_use' || kv[1] === 'whenToUse') out.whenToUse = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (kv[1] === 'category') out.category = kv[2].trim().replace(/^['"]|['"]$/g, '')
    }
    return out
  }
  /* 环境变量：进程 + 平台 config.json（空字段不覆盖） */
  const cfg = loadPlatformConfig(redteamRoot())
  const checkEnv = mergeConfigEnv(process.env, cfg)

  if (request.op === 'skillCatalog') {
    const byName = new Map()
    const items = files.map((file) => {
      const name = file.replace(/\.md$/i, '')
      const path = join(dir, file)
      let description = ''
      let whenToUse = ''
      let category = ''
      let content = ''
      try {
        content = readFileSync(path, 'utf8')
        const meta = parseMeta(content)
        description = meta.description
        whenToUse = meta.whenToUse
        category = meta.category
      } catch { /* ignore */ }
      const verdict = checkSkill(
        { name, content, path, root: dir },
        { env: checkEnv },
      )
      byName.set(name, verdict)
      return {
        name,
        description,
        whenToUse,
        category,
        provider: 'pi-purge',
        source: 'plugin',
        dir,
        modelInvocable: true,
        userInvocable: true,
        fromPlugin: true,
        library: 'redteam',
        availability: verdict.status,
        problems: verdict.problems,
        needs_user: verdict.needs_user,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
    const availSummary = summarizeSkills(Array.from(byName.values()))
    return withBothLibraries({
      ok: true,
      total: items.length,
      fromPlugin: items.length,
      availability: {
        summary: availSummary,
        checked_at: Date.now(),
        cached: false,
        broken: Array.from(byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '按本包技能文件自检（含环境适配 config.json）。工具路径、密钥和 VPS 占位符只记在缺口里，不把整条技能标成不可用。',
      },
      bySource: [{ key: 'plugin', n: items.length }],
      byDir: [{ key: dir, n: items.length }],
      note: '本包 skills/redteam 共 ' + items.length + ' 个技能；可用性已按正文与本机配置检查。',
      items,
    })
  }
  if (request.library === 'official') return readOfficialSkill(request.name)
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  const file = join(dir, request.name.endsWith('.md') ? request.name : (request.name + '.md'))
  if (!existsSync(file)) return { ok: false, error: 'skill not found: ' + request.name }
  let content = ''
  try { content = readFileSync(file, 'utf8') } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
  const meta = parseMeta(content)
  return {
    ok: true,
    name: request.name.replace(/\.md$/i, ''),
    description: meta.description,
    whenToUse: meta.whenToUse,
    category: meta.category,
    provider: 'pi-purge',
    source: 'plugin',
    path: file,
    content,
  }
}

/**
 * 智能体并发状态（「智能体」页签用）：直接读 subagents 注册表里"真正在跑"的子会话。
 * 与工具层的 `redteam_agent_slot` 同一套口径，但这里只读不占位。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'agentsStatus' }`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
async function handleAgentsOp(ctx, request) {
  if (request.op !== 'agentsStatus' && request.op !== 'setAgentsMax') return undefined
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  if (request.op === 'setAgentsMax') {
    const next = saveMaxAgents(root, request.max)
    return {
      ok: true, max: next, source: 'settings', limit: MAX_AGENTS_LIMIT,
      note: '已保存为 ' + next + ' 个并发执行智能体，**立即生效**（派活时按新值放行，不用重启 dsh web）。',
    }
  }
  const max = maxAgentsOf(root, process.env)
  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: 'subagents / sessions 注册表不可用：读不到并发占用。', max }
  }
  const children = []
  try {
    /*
     * 这里要的是"根本不是谁的子代理"的那些会话，再对每个去 listChildren。
     * 判据必须和 identity.isChildAgentContext 一致：只看委派来源 / 委派深度。
     * 早前用 `parentSession == null` 筛根，遇到"从历史续接 / 分支"的红队会话
     * （delegationDepth 0 但带 parentSession）会被整个漏掉 —— 它的子智能体
     * 不计入并发占用，于是 `redteam_agent_slot` 会放过超额派活。
     */
    const roots = sessions.list().filter((s) => {
      const header = s && s.header
      if (!header) return false
      const origin = String(header.origin || '').toLowerCase()
      if (origin === 'subagent' || origin === 'teammate' || origin === 'delegate') return false
      return Number(header.delegationDepth ?? 0) <= 0
    })
    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') children.push({ id: String(k.id), parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
        }
      } catch { /* 单个会话读不到就跳过 */ }
    }
  } catch (error) {
    return { ok: false, error: '列子会话失败：' + (error && error.message ? error.message : String(error)), max }
  }
  /* 与工具层同一份挂起状态：waitting/blocked 让出名额的智能体只显示，不计入 used */
  const runningRows = []
  const parkedRows = []
  for (const c of children) {
    if (c.activity !== 'running') continue
    if (isParked(c.parent, c.id)) parkedRows.push({ parent: c.parent, label: c.label, activity: c.activity, mode: c.mode })
    else runningRows.push({ parent: c.parent, label: c.label, activity: c.activity, mode: c.mode })
  }
  return {
    ok: true, max, used: runningRows.length, free: Math.max(max - runningRows.length, 0),
    running: runningRows.slice(0, 20), total_children: children.length,
    parked: parkedRows.length, parked_labels: parkedRows.map((p) => p.label).slice(0, 20),
    source: maxAgentsSourceOf(root, process.env),
    limit: MAX_AGENTS_LIMIT,
    default_max: DEFAULT_MAX_AGENTS,
    note: '同一会话（靶标）同时最多 ' + max + ' 个执行智能体；默认顺序派活。'
      + (parkedRows.length ? '（另有 ' + parkedRows.length + ' 个在等人给资源，已让出名额）' : ''),
  }
}

/**
 * 版本与更新类 op（面板右上角的「版本 + 自动更新」用）。
 * 不碰资产库，直接操作 profile 与 npm/pnpm；全部在 host 侧执行。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'version' | 'updateCheck' | 'updateApply', target? }`。
 * @returns JSON 结果，或 undefined 表示不是更新类 op。
 */
async function handleUpdateOp(ctx, request) {
  if (!['version', 'updateCheck', 'updateApply'].includes(request.op)) return undefined
  /* 私有固定版本：不查 npm / GitHub，不安装，不重启宿主。 */
  const pkg = pluginIdentity(ctx)
  return {
    ok: false,
    sealed: true,
    current: pkg.version,
    plugin: pkg,
    latest: null,
    updateAvailable: false,
    localAhead: false,
    install: { mode: 'sealed', packageManager: null },
    blockers: [],
    notes: ['私有固定版本，更新已关闭。'],
    error: '私有固定版本，更新已关闭',
    running_agents: [],
  }
}


/**
 * @param ctx - 插件上下文（已保证 redteam / webServer / skills / agentPresets 可用）。
 */
export function apply(ctx) {
  const store = ctx.redteam

  /* 红队会话发送后的硬兜底：环境未就绪则 reject 首步，避免直接开干 */
  try {
    if (!ctx.__dshpEnvAdaptPreStep) {
      ctx.__dshpEnvAdaptPreStep = true
      const root = store && store.root ? store.root : redteamRoot()
      const hook = async (payload, next) => {
        try {
          const agent = payload && payload.agent
          const header = agent && agent.session && agent.session.header
          const preset = header && header.agentPreset
          if (preset === 'redteam') {
            const turn = Number(payload && payload.turn) || 0
            const step = Number(payload && payload.step) || 0
            if (turn <= 1 && step <= 1) {
              const status = envAdaptStatus(root)
              if (!status.ready) {
                return {
                  kind: 'reject',
                  reason: status.message
                    || '环境未适配：请打开 pi-purge → 环境适配配置工具，或确认暂不配置后再发送。',
                  messages: [],
                }
              }
            }
          }
        } catch { /* 门禁异常不阻断 */ }
        return next()
      }
      // ctx.effect 包起来 → plugin dispose 时自动解绑 hook,avoids 事件处理器残留触发已卸载代码。
      // installed flag 防重复注册(cordis 允许同一 handler 重复注册,会多次触发)。
      ctx.effect(() => {
        let installed = false
        let disposer = null
        const install = () => {
          if (installed) return
          try {
            disposer = ctx.on('agent/pre-step', hook, { global: true, prepend: true })
            installed = true
          } catch { /* ignore */ }
        }
        install()
        queueMicrotask(install)
        const timer = setTimeout(install, 800)
        return () => {
          clearTimeout(timer)
          try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ }
          delete ctx.__dshpEnvAdaptPreStep
        }
      })
    }
  } catch { /* ignore */ }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/redteam/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      /* 来源校验：本机回环一律放行（官方桌面端 Origin 常是 app:// / file://，
         旧逻辑会把 Origin.host 判空后直接 403，导致技能库/知识库/SQL 全挂）。
         非回环才要求 Origin 与 Host 同源。
         补充：桌面端若通过本机 LAN 地址访问（Host 不是 localhost），连接的对端仍在本机，
         Origin 又是 app:// / file:// / null ——同样放行；只有"外机连进来"才按同源严格判。 */
      const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const origin = req.headers.origin
      const originText = typeof origin === 'string' ? origin.trim() : ''
      const originMissing = origin === undefined || originText === ''
      const nullOrigin = originText === 'null'
      const appOrigin = APP_ORIGIN_RE.test(originText)
      const selfConn = loopback || selfAddressSet().has(remote)
      const originOk = (() => {
        if (loopback) return true
        /* 本机连接 + 自定义协议/无 Origin：桌面端；不含 `null`（沙箱 iframe 也能发 null，留作 CSRF 边界） */
        if (selfConn && (originMissing || appOrigin)) return true
        /* 官方桌面端：Origin 常为 app:// / null，Host 仍是 127.0.0.1:port */
        if (hostLocal) {
          if (nullOrigin || appOrigin) return true
          try {
            const oh = new URL(origin).host
            if (oh === host || oh === '' ) return true
          } catch { /* fall through */ }
        }
        if (typeof origin !== 'string' || origin === '') return false
        let originHost = null
        try { originHost = new URL(origin).host } catch { originHost = null }
        return originHost !== null && originHost === host
      })()
      if (!originOk) {
        logCorsReject(req, {
          path: '/redteam/api', remote, host, origin,
          site: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : '',
        })
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() ? JSON.parse(raw) : {}
        const platformResult = handlePlatformOp(store, request)
        if (platformResult !== undefined) {
          sendJson(res, 200, platformResult)
          return
        }
        const agentsResult = await handleAgentsOp(ctx, request)
        if (agentsResult !== undefined) {
          sendJson(res, 200, agentsResult)
          return
        }
        const updateResult = await handleUpdateOp(ctx, request)
        if (updateResult !== undefined) {
          sendJson(res, 200, updateResult)
          return
        }
        let skillResult
        try {
          skillResult = await handleSkillOp(ctx, request)
        } catch (skillErr) {
          /* 桌面端 inject 缺失时绝不 400：直接文件兜底 */
          if (request && (request.op === 'skillCatalog' || request.op === 'skillRead')) {
            skillResult = handleSkillOpFromPluginDir(request)
            if (!skillResult || skillResult.ok === false) {
              skillResult = {
                ok: false,
                error: '技能读取失败：' + (skillErr && skillErr.message ? skillErr.message : String(skillErr)),
              }
            }
          } else {
            throw skillErr
          }
        }
        const withRoot = (typeof request.session === 'string' && request.session)
          ? Object.assign({}, request, { resolveRoot: (sid) => resolveRootSessionId(ctx, sid) })
          : request
        sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, withRoot) : skillResult)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
