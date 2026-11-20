import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { asarArchiveIsFile, diskFs, hostFs } from "./extract-asar.js";
import { hostPromptKeepsInject } from "./host-clean.js";
import { atomicCopyFileSync, atomicWriteSync } from "./core.js";
import { argvHasBareCommand, detectSurface, looksOfficialDesktopHost, pathLooksDesktop } from "./surface.js";

function restartUniqSuffix() {
  return `${process.pid}-${randomBytes(4).toString("hex")}`;
}

// 无归档时用 node:fs。app.asar 还在时不能把映射出来的 resources/app 当成已经解开。
const fs = hostFs;

// [pi-purge-fix 2026-10-09] console.warn 写 host stderr → main.js:3729 host.exitPromise
// fail 回调把最后一行 stderr 当 Error reason。helper restart 期间任何 warn 都可能
// 被误判成 crash log。改走内部文件,不污染 stderr。
const INTERNAL_LOG_PATH = path.join(os.tmpdir(), "pi-purge-desktop.log");
function logInternal(msg) {
  try {
    const line = `${new Date().toISOString()} [pi-purge] ${String(msg)}\n`;
    fs.appendFileSync(INTERNAL_LOG_PATH, line, "utf8");
  } catch {
    /* 日志写不进去就吞,绝不走 stderr */
  }
}

/** 启动一次：清掉旧版本留下的无 pid 后缀的 restart 脚本/日志（超过 24h）。 */
export function cleanupLegacyRestartScripts() {
  const tmp = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch { return; }
  const pat = /^pi-purge-official-restart(?:-[0-9a-f-]+)?\.(?:js|cmd|log)$/i;
  for (const name of entries) {
    if (!pat.test(name)) continue;
    const fp = path.join(tmp, name);
    try {
      const st = fs.statSync(fp);
      if (Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    } catch { /* ignore */ }
  }
}

/** 路径落在 `app.asar/...` 里面。`app.asar` 文件本身和 `app.asar.unpacked` 不算。 */
export function isAsarSealedPath(p) {
  const parts = String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return false;
  return parts.slice(0, -1).some((seg) => {
    const s = seg.toLowerCase();
    return s.endsWith(".asar") && !s.endsWith(".asar.unpacked");
  });
}

function isFile(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

function isDir(fp) {
  try {
    if (isAsarSealedPath(fp)) return false;
    return Boolean(fp) && fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

function isAiBase(p) {
  return Boolean(p) && isDir(path.join(p, "dsh-agent-instructions", "lib"));
}

function uniquePaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const n = path.normalize(item);
    const key = n.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function slashNorm(p) {
  return path.normalize(String(p || "")).replace(/\\/g, "/").toLowerCase();
}

function isSubPath(child, root) {
  const c = slashNorm(child).replace(/\/+$/, "");
  const r = slashNorm(root).replace(/\/+$/, "");
  if (!c || !r || r === "/") return false;
  if (/^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

/**
 * 社区桌面、官方 exe、.app 包才算安装树。
 * 只是上级文件夹叫 DeepSeek Harness 不算：npm 前缀和配置目录经常用这个名字，
 * 按名字整棵排除的话，Web 的身份句和 complete 注入补丁会被跳过。
 */
export function looksLikeDesktopName(p) {
  const n = slashNorm(p);
  if (!n) return false;
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.endsWith("/dsh desktop") ||
    n.endsWith("/dsh desktop.app") ||
    n.includes("dsh-desktop") ||
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness(\/|$)/.test(n) ||
    n.includes("/deepseek harness.app/") ||
    n.endsWith("/deepseek harness.app") ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n)
  );
}

const OFFICIAL_HARNESS_BASES = new Set([
  "deepseek harness.exe",
  "deepseek-harness.exe",
  "deepseek harness",
  "deepseek-harness",
]);

/**
 * 只把「路径自己那一段」当桌面名字，不看祖先目录。
 *
 * 上面那段注释说要避免的事，原实现其实在做：`n.includes("/deepseek harness/")`
 * 会命中任意祖先目录。而 npm 前缀（`D:\DeepSeek Harness\npm-global\…`）和
 * DSH_HOME 的父目录（`D:\DeepSeek Harness\.dsh` 的上级）恰好都叫这个名字 ——
 * 于是 Web 安装根被判成桌面，findAiBaseWeb 里每一处
 * `!isInsideDesktopInstall(cand)` 守卫都会把正确答案踢掉，Web 面定位不到宿主。
 *
 * 真正的桌面安装靠结构标记判定：路径里含 `/resources/app/`、
 * `/resources/app.asar.unpacked/` 或 `/contents/resources/`（见 inferDesktopInstallDir）。
 * 名字只作为「这一级目录本身就是安装根」的兜底。
 */
export function looksLikeDesktopNameTail(p) {
  const n = slashNorm(p).toLowerCase().replace(/\/+$/, "");
  if (!n) return false;
  const cut = n.lastIndexOf("/");
  const tail = cut >= 0 ? n.slice(cut + 1) : n;
  if (!tail) return false;
  return (
    tail === "dsh desktop" ||
    tail === "dsh desktop.app" ||
    tail === "deepseek harness" ||
    tail === "deepseek harness.app" ||
    tail === "deepseek-harness" ||
    tail === "deepseekharness" ||
    /^dsh-desktop/.test(tail) ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(tail)
  );
}

function sameBase(name, expected) {
  return String(name || "").toLowerCase() === expected;
}

export function isDesktopExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (base === "dsh desktop.exe" || base === "dsh desktop") return true;
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 只有官方 DeepSeek Harness 会把宿主封进 app.asar 并在「应用」时解开。第三方 DSH Desktop 不走这条。 */
export function isOfficialHarnessExecutable(fp) {
  const base = path.basename(String(fp || "")).toLowerCase();
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/** 某个安装目录下可能的 resources 文件夹（mac 大小写敏感盘要 Resources 和 resources 都试）。 */
export function resourceDirCandidates(installDir) {
  if (!installDir) return [];
  const name = path.basename(installDir);
  if (sameBase(name, "macos")) {
    const contents = path.dirname(installDir);
    return [path.join(contents, "Resources"), path.join(contents, "resources")];
  }
  if (sameBase(name, "contents")) {
    return [path.join(installDir, "Resources"), path.join(installDir, "resources")];
  }
  if (name.toLowerCase().endsWith(".app")) {
    return [
      path.join(installDir, "Contents", "Resources"),
      path.join(installDir, "Contents", "resources"),
    ];
  }
  if (sameBase(name, "resources")) return [installDir];
  return [path.join(installDir, "resources"), path.join(installDir, "Resources")];
}

/** 官方宿主的 resources 目录。已存在的 app.asar 优先，否则用该平台的常规目录名。 */
export function resourcesDirForExecutable(exe) {
  const exeDir = path.dirname(path.normalize(String(exe || "")));
  if (!exeDir) return "";
  const cands = resourceDirCandidates(exeDir);
  const withAsar = cands.find((dir) => isFile(path.join(dir, "app.asar")));
  if (withAsar) return withAsar;
  const existing = cands.find((dir) => isDir(dir));
  if (existing) return existing;
  return cands[0] || "";
}

export function appAsarPath(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app.asar") : "";
}

export function appDirForExecutable(exe) {
  const dir = resourcesDirForExecutable(exe);
  return dir ? path.join(dir, "app") : "";
}

const OFFICE_SKILL_MARKER = ["office", "SKILL.md"];

function copySkillTree(src, dest, reader, writer) {
  writer.mkdirSync(dest, { recursive: true });
  let entries;
  try {
    entries = reader.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copySkillTree(from, to, reader, writer);
    else if (entry.isFile() && !writer.existsSync(to)) {
      writer.mkdirSync(path.dirname(to), { recursive: true });
      writer.writeFileSync(to, reader.readFileSync(from));
    }
  }
}

/**
 * 0.2.1 桌面 Host 启动时 dsh-skill-office 会同步读
 * `resources/runtime/office-skills/office/SKILL.md`。缺文件就是 DesktopHostFatalError。
 * 从包内 assets / app/runtime 把缺的 SKILL.md 补回磁盘。
 */
export function healOfficeSkillsAt(resourcesDir, appDir = "", extraSources = []) {
  if (!resourcesDir) return { ok: false, reason: "no-resources" };
  const dest = path.join(resourcesDir, "runtime", "office-skills");
  const marker = path.join(dest, ...OFFICE_SKILL_MARKER);
  const out = diskFs();
  if (out.existsSync(marker)) return { ok: true, healed: false, dest };
  const sources = [
    appDir ? path.join(appDir, "runtime", "office-skills") : "",
    appDir ? path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets") : "",
    path.join(resourcesDir, "app", "runtime", "office-skills"),
    path.join(resourcesDir, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    // 打包安装里资源在 app.asar 内，不在磁盘上；hostFs 认 asar 路径，能读出来。
    path.join(resourcesDir, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    path.join(resourcesDir, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai", "dsh-skill-office", "assets"),
    ...(Array.isArray(extraSources) ? extraSources : []),
  ].filter(Boolean);
  const src = sources.find((dir) => {
    try {
      return hostFs.existsSync(path.join(dir, ...OFFICE_SKILL_MARKER));
    } catch {
      return false;
    }
  });
  if (!src) return { ok: false, reason: "no-source", dest };
  try {
    copySkillTree(src, dest, hostFs, out);
    return { ok: out.existsSync(marker), healed: true, src, dest };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error), src, dest };
  }
}

export function healOfficeSkillsRuntimeOnDisk(extraSources = []) {
  const exe = findDesktopAppExecutable();
  if (!exe || !isOfficialHarnessExecutable(exe)) return { ok: false, reason: "no-exe" };
  return healOfficeSkillsAt(resourcesDirForExecutable(exe), appDirForExecutable(exe), extraSources);
}

function exeCandidatesBeside(dir) {
  if (!dir) return [];
  return [
    path.join(dir, "DeepSeek Harness.exe"),
    path.join(dir, "DeepSeekHarness.exe"),
    path.join(dir, "deepseek-harness.exe"),
    path.join(dir, "DeepSeek Harness"),
    path.join(dir, "DeepSeekHarness"),
    path.join(dir, "deepseek-harness"),
    path.join(dir, "DSH Desktop.exe"),
    path.join(dir, "DSH Desktop"),
    path.join(dir, "MacOS", "DeepSeek Harness"),
    path.join(dir, "MacOS", "deepseek-harness"),
    path.join(dir, "MacOS", "DSH Desktop"),
    path.join(dir, "Contents", "MacOS", "DeepSeek Harness"),
    path.join(dir, "Contents", "MacOS", "deepseek-harness"),
    path.join(dir, "Contents", "MacOS", "DSH Desktop"),
  ];
}

function firstExistingExe(dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const cand of exeCandidatesBeside(dir)) {
      if (isFile(cand)) return path.normalize(cand);
    }
  }
  return "";
}

const APP_SCRIPT_RE = /(desktop-cli|host-process-entry)\.js$/i;

function installDirsFromAppScript(scriptPath) {
  if (!scriptPath) return [];
  const abs = path.resolve(scriptPath);
  const lib = path.dirname(abs);
  const app = path.dirname(lib);
  const resources = path.dirname(app);
  const install = path.dirname(resources);
  return uniquePaths([lib, app, resources, install]);
}

/** 从任意 `.../resources/app/...` 树反推安装目录（不要求文件夹叫 DSH Desktop）。 */
export function inferDesktopInstallDir(p) {
  const raw = path.normalize(String(p || "")).replace(/\\/g, "/");
  const n = raw.toLowerCase();
  if (!n) return "";
  const markers = [
    "/resources/app.asar.unpacked/",
    "/resources/app/",
    "/contents/resources/",
  ];
  for (const marker of markers) {
    const i = n.indexOf(marker);
    if (i <= 0) continue;
    return path.normalize(raw.slice(0, i));
  }
  return "";
}

function extraInstallsFromEnv(env = process.env) {
  return String(env.DSH_DESKTOP_INSTALL || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustedInstallDir(dir) {
  if (!dir) return false;
  if (looksLikeDesktopName(dir)) return true;
  if (firstExistingExe([dir])) return true;
  return (
    isAiBase(path.join(dir, "resources", "app", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai")) ||
    isAiBase(path.join(dir, "resources", "app.asar.unpacked", "node_modules", "@deepseek-ai"))
  );
}

const REGISTRY_INSTALL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$names = @('DeepSeek Harness','DSH Desktop')
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$rows = foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { return }
    $hit = $false
    foreach ($n in $names) { if ($p.DisplayName -like ('*' + $n + '*')) { $hit = $true } }
    if (-not $hit) { return }
    [pscustomobject]@{
      InstallLocation = [string]$p.InstallLocation
      DisplayIcon = [string]$p.DisplayIcon
      UninstallString = [string]$p.UninstallString
    }
  }
}
if ($rows) { @($rows) | ConvertTo-Json -Compress }
`.trim();

function exeDirFromRegistryValue(value) {
  let val = String(value || "").trim();
  const quoted = val.match(/^"([^"]+)"/);
  if (quoted) val = quoted[1];
  val = val.replace(/,0$/, "").trim();
  if (!val) return "";
  return path.normalize(path.dirname(val));
}

let cachedRegistryDirs;
/** 从卸载登记读安装目录。盘符跟着用户安装位置，不写死。 */
export function registryInstallDirs() {
  if (cachedRegistryDirs !== undefined) return cachedRegistryDirs;
  if (process.platform !== "win32") {
    cachedRegistryDirs = [];
    return cachedRegistryDirs;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", REGISTRY_INSTALL_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const found = [];
  for (const row of rows) {
    const location = String(row.InstallLocation || "").trim();
    if (location) found.push(path.normalize(location));
    found.push(exeDirFromRegistryValue(row.DisplayIcon));
    found.push(exeDirFromRegistryValue(row.UninstallString));
  }
  const result = uniquePaths(found).filter((dir) => firstExistingExe([dir]));
  if (result.length > 0) cachedRegistryDirs = result;
  return result;
}

const PORTABLE_INSTALL_NAMES = [
  "DeepSeek Harness",
  "DeepSeekHarness",
  "DeepseekHarnessDesktop",
  "DeepSeekHarnessDesktop",
  "DSH Desktop",
  "deepseek-harness",
];

function homeSiblingInstalls(env = process.env) {
  const homes = [env.DSH_HOME, env.DSH_BASE].filter(Boolean);
  const dirs = [];
  for (const raw of homes) {
    const start = path.normalize(String(raw));
    dirs.push(start, path.dirname(start), path.dirname(path.dirname(start)));
  }
  return uniquePaths(dirs).filter((dir) => firstExistingExe([dir]));
}

/** 用户目录和各盘根下一层常见文件夹名。不扫整盘。 */
function portableInstallGuesses(env = process.env) {
  const home = os.homedir();
  const cands = [];
  for (const folder of ["Desktop", "Documents", "Downloads"]) {
    for (const name of PORTABLE_INSTALL_NAMES) {
      cands.push(path.join(home, folder, name));
    }
  }
  for (const name of PORTABLE_INSTALL_NAMES) {
    cands.push(path.join(home, name));
  }
  if (process.platform === "win32") {
    for (const letter of "CDEFGHI") {
      for (const name of PORTABLE_INSTALL_NAMES) {
        cands.push(`${letter}:\\${name}`);
      }
    }
  }
  return uniquePaths(cands).filter((dir) => firstExistingExe([dir]));
}

function walkParentsForOfficialExe(start, maxUp = 8) {
  if (!start) return "";
  let dir = "";
  try {
    const abs = path.resolve(String(start));
    dir = isDir(abs) ? abs : path.dirname(abs);
  } catch {
    return "";
  }
  for (let i = 0; i < maxUp && dir; i += 1) {
    const hit = firstExistingExe([dir]);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

const PROCESS_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$re = 'DeepSeek.*Harness\\.exe$|DSH Desktop\\.exe$'
$paths = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match $re } |
  Select-Object -ExpandProperty ExecutablePath)
if ($paths) { @($paths) | ConvertTo-Json -Compress }
`.trim();

let cachedRunningExes;
function runningOfficialExecutables() {
  if (cachedRunningExes !== undefined) return cachedRunningExes;
  if (process.platform !== "win32") {
    cachedRunningExes = [];
    return cachedRunningExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", PROCESS_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      // 15s 会把启动期的 UI 线程卡 15s;Win32_Process 枚举 1-3s 够用,超时直接退不缓存。
      timeout: 6000,
      maxBuffer: 8 << 20,
    });
  } catch {
    // 探测失败不缓存空结果，否则整次进程都找不到正在跑的客户端。
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  // 结果为空也不缓存：客户端可能稍后才启动，否则本进程后续永远找不到它。
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedRunningExes = result;
  return result;
}

const SHORTCUT_EXE_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$shell = New-Object -ComObject WScript.Shell
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ }
$pats = @('*DeepSeek*Harness*.lnk','*DSH Desktop*.lnk','*deepseek-harness*.lnk')
$out = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($pat in $pats) {
    Get-ChildItem -LiteralPath $root -Filter $pat -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 16 | ForEach-Object {
        try {
          $t = $shell.CreateShortcut($_.FullName).TargetPath
          if ($t) { $out.Add([string]$t) }
        } catch {}
      }
  }
}
if ($out.Count) { @($out) | ConvertTo-Json -Compress }
`.trim();

let cachedShortcutExes;
function shortcutOfficialExecutables() {
  if (cachedShortcutExes !== undefined) return cachedShortcutExes;
  if (process.platform !== "win32") {
    cachedShortcutExes = [];
    return cachedShortcutExes;
  }
  let text = "";
  try {
    text = execFileSync("powershell.exe", ["-NoProfile", "-Command", SHORTCUT_EXE_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 << 20,
    });
  } catch {
    return [];
  }
  let rows = [];
  try {
    const parsed = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim() || "[]");
    rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
  const result = uniquePaths(rows.map((item) => String(item || "").trim()).filter((fp) => isDesktopExecutable(fp) && isFile(fp)));
  if (result.length > 0) cachedShortcutExes = result;
  return result;
}

/** 点「应用」前清掉失败的空缓存，重新找本机 exe。 */
export function clearDesktopLocateCache() {
  cachedRunningExes = undefined;
  cachedShortcutExes = undefined;
  cachedRegistryDirs = undefined;
}

function extraDiscoveredInstallDirs(env = process.env, input = {}) {
  const cheap = [
    ...homeSiblingInstalls(env),
    ...portableInstallGuesses(env),
  ];
  if (input.discover !== true) return uniquePaths(cheap);
  return uniquePaths([
    ...cheap,
    ...runningOfficialExecutables().map((exe) => path.dirname(exe)),
    ...shortcutOfficialExecutables().map((exe) => path.dirname(exe)),
  ]);
}

/** NSIS / 商店默认位置；不是全盘扫描。discover 才查注册表 / 进程 / 快捷方式。 */
export function commonDesktopInstallDirs(env = process.env, input = {}) {
  const discover = input.discover === true;
  const home = os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = env.ProgramFiles || "";
  const pf86 = env["ProgramFiles(x86)"] || "";
  return uniquePaths([
    ...extraInstallsFromEnv(env).filter(trustedInstallDir),
    ...(discover ? registryInstallDirs() : []),
    ...extraDiscoveredInstallDirs(env, { discover }),
    path.join(local, "Programs", "DeepSeek Harness"),
    path.join(local, "Programs", "DSH Desktop"),
    path.join(local, "DeepSeek Harness"),
    ...(pf
      ? [path.join(pf, "DeepSeek Harness"), path.join(pf, "DSH Desktop")]
      : []),
    ...(pf86
      ? [path.join(pf86, "DeepSeek Harness"), path.join(pf86, "DSH Desktop")]
      : []),
    "/Applications/DeepSeek Harness.app",
    "/Applications/DSH Desktop.app",
    path.join(home, "Applications", "DeepSeek Harness.app"),
    path.join(home, "Applications", "DSH Desktop.app"),
    "/opt/DeepSeek Harness",
    "/opt/deepseek-harness",
    "/usr/lib/DeepSeek Harness",
    "/usr/lib/deepseek-harness",
    "/usr/share/deepseek-harness",
    path.join(home, ".local", "share", "DeepSeek Harness"),
    path.join(home, ".local", "share", "deepseek-harness"),
    "/opt/DSH Desktop",
    "/usr/lib/dsh-desktop",
  ]);
}

export function listDesktopInstallRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const roots = [];

  if (isDesktopExecutable(execPath)) {
    const dir = path.dirname(path.normalize(execPath));
    roots.push(dir);
    if (sameBase(path.basename(dir), "macos")) {
      const contents = path.dirname(dir);
      roots.push(
        contents,
        path.join(contents, "Resources"),
        path.join(contents, "resources"),
        path.dirname(contents),
      );
    }
  }

  if (resourcesPath) {
    const res = path.normalize(resourcesPath);
    roots.push(res, path.dirname(res), path.join(res, "app"), path.join(res, "app.asar.unpacked"));
  }

  for (const arg of argv) {
    if (typeof arg === "string" && APP_SCRIPT_RE.test(arg)) {
      roots.push(...installDirsFromAppScript(arg));
    }
  }

  for (const extra of extraInstallsFromEnv(env)) {
    if (trustedInstallDir(extra)) roots.push(extra);
  }
  return uniquePaths(roots);
}

/**
 * 是否落在社区 Desktop 安装树。
 * 不依赖盘符、也不要求文件夹叫 “DSH Desktop”：
 * 当前进程的 exe / resources / host-process-entry、旁边真有桌面 exe，或社区安装目录名。
 */
export function isInsideDesktopInstall(p, input = {}) {
  if (!p) return false;
  // 名字兜底只看路径尾部那一段，不看祖先目录名 —— 见 looksLikeDesktopNameTail。
  if (looksLikeDesktopNameTail(p)) return true;
  const roots = listDesktopInstallRoots(input);
  if (roots.some((root) => isSubPath(p, root))) return true;
  const inferred = inferDesktopInstallDir(p);
  if (!inferred) return false;
  if (roots.some((root) => isSubPath(inferred, root) || isSubPath(root, inferred))) return true;
  return Boolean(firstExistingExe([inferred]));
}

export function findDesktopAppExecutable(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;

  if (isDesktopExecutable(execPath) && isFile(execPath)) return path.normalize(execPath);

  if (resourcesPath) {
    const hit = firstExistingExe([path.dirname(path.normalize(resourcesPath))]);
    if (hit) return hit;
  }

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const hit = firstExistingExe(installDirsFromAppScript(arg));
    if (hit) return hit;
  }

  const walkStarts = [execPath, resourcesPath, env.DSH_HOME, env.DSH_BASE];
  try { walkStarts.push(process.cwd()); } catch { /* ignore */ }
  for (const arg of argv) {
    if (typeof arg === "string") walkStarts.push(arg);
  }
  for (const start of walkStarts) {
    const hit = walkParentsForOfficialExe(start);
    if (hit) return hit;
  }

  if (discover) {
    const running = runningOfficialExecutables();
    if (running[0]) return running[0];
    const shortcuts = shortcutOfficialExecutables();
    if (shortcuts[0]) return shortcuts[0];
  }

  const guessed = firstExistingExe([
    ...extraInstallsFromEnv(env),
    ...commonDesktopInstallDirs(env, { discover }),
  ]);
  return guessed || "";
}

function packageRootsFromInstall(installDir) {
  if (!installDir) return [];
  const out = [];
  for (const resources of resourceDirCandidates(installDir)) {
    out.push(
      path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resources, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }
  return out;
}

export function listDesktopPackageRoots(input = {}) {
  const execPath = input.execPath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const argv = input.argv ?? process.argv;
  const env = input.env ?? process.env;
  const discover = input.discover === true;
  const cands = [];

  if (resourcesPath) {
    cands.push(
      path.join(resourcesPath, "app", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@deepseek-ai"),
    );
  }

  if (isDesktopExecutable(execPath)) {
    cands.push(...packageRootsFromInstall(path.dirname(execPath)));
  }

  const exe = findDesktopAppExecutable(input);
  if (exe) cands.push(...packageRootsFromInstall(path.dirname(exe)));

  for (const arg of argv) {
    if (typeof arg !== "string" || !APP_SCRIPT_RE.test(arg)) continue;
    const appDir = path.dirname(path.dirname(path.resolve(arg)));
    cands.push(path.join(appDir, "node_modules", "@deepseek-ai"));
    cands.push(path.join(appDir, "dsh", "node_modules", "@deepseek-ai"));
    cands.push(...packageRootsFromInstall(path.dirname(path.dirname(appDir))));
  }

  const localHits = uniquePaths(cands).filter(isAiBase);
  // 已经在某个桌面 exe 里时，只改这一份。旁边装了另一种客户端也不能被带上。
  if (isDesktopExecutable(execPath)) return localHits;
  // 启动自愈：exe / 环境 / 常见目录已经够用。注册表和快捷方式留给点「应用」。
  if (!discover && localHits.length) return localHits;

  for (const install of commonDesktopInstallDirs(env, { discover })) {
    cands.push(...packageRootsFromInstall(install));
  }

  return uniquePaths(cands).filter(isAiBase);
}

export function resolveDesktopAiBase(input = {}) {
  return listDesktopPackageRoots(input)[0] || null;
}

export function isSealedRuntimeDir(dir) {
  if (!dir) return false;
  const n = path.normalize(dir).replace(/\\/g, "/").toLowerCase();
  if (!/(^|\/)bin\/?$/.test(n)) return false;
  return (
    n.includes("/host-commands/") ||
    n.includes("/runtime-commands/") ||
    n.includes("/dsh desktop/")
  );
}

export function sealedRuntimeRoots(env = process.env) {
  const home = os.homedir();
  const appdata = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localapp = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return uniquePaths([
    path.join(appdata, "DSH Desktop", "host-commands"),
    path.join(appdata, "DSH Desktop", "runtime-commands"),
    path.join(localapp, "DSH Desktop", "host-commands"),
    path.join(localapp, "DSH Desktop", "runtime-commands"),
    path.join(home, "Library", "Application Support", "DSH Desktop", "host-commands"),
  ]);
}

function walkBinDirs(dir, out, depth) {
  if (depth < 0 || !isDir(dir)) return;
  const n = dir.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)bin$/.test(n)) {
    out.push(path.normalize(dir));
    return;
  }
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (ent.isDirectory()) walkBinDirs(path.join(dir, ent.name), out, depth - 1);
  }
}

export function listSealedRuntimeBins(env = process.env) {
  const out = [];
  for (const root of sealedRuntimeRoots(env)) walkBinDirs(root, out, 5);
  return uniquePaths(out).filter(isSealedRuntimeDir);
}

export function restartNote() {
  return "正在重启桌面应用…";
}

function exeForThisProcess(input = {}) {
  const execPath = path.normalize(String((input.execPath ?? process.execPath) || ""));
  if (execPath && isDesktopExecutable(execPath) && isFile(execPath)) return execPath;
  return officialExeFromProcess() || findDesktopAppExecutable(input) || "";
}

export function restartPlan(input = {}) {
  const exe = exeForThisProcess(input);
  if (!exe) {
    return { kind: "desktop", execPath: "", argv: [], cwd: "", error: "未找到 DSH Desktop.exe，无法重启桌面应用" };
  }
  return {
    kind: "desktop",
    execPath: exe,
    argv: [],
    cwd: path.dirname(exe),
  };
}

function helperEnv(payload) {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  env.ELECTRON_RUN_AS_NODE = "1";
  env.DSH_SURFACE = "desktop";
  if (!String(env.DSH_PROFILE || "").trim()) env.DSH_PROFILE = "desktop";
  env.PI_PURGE_RESTART = JSON.stringify(payload);
  return env;
}

// #85 reverted: host 自己同步杀 Electron 会导致 host 作为 Electron 子进程被 Job
// Object 连带杀,spawnHelper 来不及调用 → relaunch 彻底失败 (YG 实测现象:点"重启"
// 没反应,DSH 全死没 relaunch)。改回让 helper 全权处理 kill+relaunch,crash dialog
// 问题靠 patch #83+#84 (新 main.js 加载后 close 回调 silent) 解决第二次之后,
// 第一次 restart 的 crash dialog 是 Electron 内存版本滞后的必然代价,无法避免。

function spawnDesktopHelperAndWait(payload) {
  const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  const alive = path.join(os.tmpdir(), `pi-purge-desk-alive-${process.pid}`);
  try { fs.unlinkSync(alive); } catch { /* 没有上一轮标记 */ }
  try { fs.unlinkSync(`${alive}.go`); } catch { /* 没有上一轮放行 */ }
  try {
    spawnHelper(helper, { ...payload, alivePath: alive }, { exit: false });
  } catch (error) {
    return {
      restarting: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!waitForFile(alive, 4000)) {
    logInternal("desktop restart helper did not start, keeping app alive");
    return { restarting: false, error: "重启助手没有启动，应用未退出。请完全退出后再点重启。", keptAlive: true };
  }
  return { restarting: true, goPath: `${alive}.go` };
}

function spawnHelper(helper, payload, opts = {}) {
  const plan = restartPlan();
  const hinted = payload && payload.execPath ? payload.execPath : "";
  const execPath = hinted || plan.execPath;
  if (!execPath) throw new Error(plan.error || "未找到 DSH Desktop.exe，无法重启桌面应用");
  const env = helperEnv({
    kind: "desktop",
    execPath,
    argv: plan.argv,
    cwd: plan.cwd || path.dirname(execPath),
    pid: process.pid,
    ...payload,
  });
  if (process.platform === "win32") {
    const ps1 = path.join(os.tmpdir(), `pi-purge-spawn-helper-${restartUniqSuffix()}.ps1`);
    const body = [
      "\uFEFF$ErrorActionPreference = 'Continue'",
      "$env:ELECTRON_RUN_AS_NODE = '1'",
      "$env:DSH_SURFACE = 'desktop'",
      "if (-not $env:DSH_PROFILE) { $env:DSH_PROFILE = 'desktop' }",
      `$env:PI_PURGE_RESTART = ${psSingleQuote(env.PI_PURGE_RESTART)}`,
      "Remove-Item Env:DSH_PERMISSION_MODE -ErrorAction SilentlyContinue",
      `$p = Start-Process -FilePath ${psSingleQuote(process.execPath)} -ArgumentList @(${psSingleQuote(helper)}) -WindowStyle Hidden -PassThru`,
      "if (-not $p) { throw 'Start-Process helper failed' }",
    ].join("\r\n");
    diskFs().writeFileSync(ps1, body, "utf8");
    spawnPowerShellOutsideJob([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      ps1,
    ]);
  } else {
    const child = spawn(process.execPath, [helper], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env,
    });
    child.unref();
  }
  if (opts.exit !== false) setTimeout(() => process.exit(0), opts.exitAfter ?? 250);
}

function desktopRuntimeOf(ctx) {
  if (!ctx || typeof ctx.get !== "function") return null;
  const runtime = ctx.get("desktopRuntime") || ctx.get("desktopActions");
  return runtime && typeof runtime.requestRestart === "function" ? runtime : null;
}

function win32CommandLine(args) {
  return args.map((arg) => {
    const s = String(arg);
    if (s === "") return '""';
    if (!/[\s"]/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
  }).join(" ");
}

function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 拉起官方 GUI：WMI Create exe，不经 cmd，不继承控制台 / NODE_OPTIONS。 */
const START_DESKTOP_GUI_PS = [
  "function Start-DesktopGui([string]$Exe) {",
  "  foreach ($n in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','ELECTRON_ENABLE_LOGGING','ELECTRON_LOG_FILE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) {",
  "    Remove-Item \"Env:$n\" -ErrorAction SilentlyContinue",
  "  }",
  "  $env:ELECTRON_NO_ATTACH_CONSOLE = '1'",
  "  $env:NO_PROXY = '*'",
  "  $env:no_proxy = '*'",
  "  if (-not $Exe) { throw 'missing exe' }",
  "  $dir = Split-Path -Parent $Exe",
  "  $cmd = '\"' + $Exe + '\"'",
  "  try {",
  "    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $dir }",
  "    if ($r -and $r.ReturnValue -eq 0 -and $r.ProcessId) { return }",
  "  } catch {}",
  "  $si = New-Object System.Diagnostics.ProcessStartInfo",
  "  $si.FileName = $Exe",
  "  $si.UseShellExecute = $true",
  "  $si.WorkingDirectory = $dir",
  "  [void][System.Diagnostics.Process]::Start($si)",
  "}",
].join("\r\n");

/** Electron/Chromium job 会在杀宿主时带走 detached 子进程。WMI Create 的父进程是 WmiPrvSE（#133）。 */
export function spawnPowerShellOutsideJob(psArgs) {
  const real = diskFs();
  const commandLine = win32CommandLine(["powershell.exe", ...psArgs]);
  const argList = psArgs.map(psSingleQuote).join(",");
  const launcherPs1 = path.join(os.tmpdir(), `pi-purge-wmi-launch-${process.pid}-${Date.now()}.ps1`);
  const body = [
    "\uFEFF$ErrorActionPreference = 'Continue'",
    `$cmd = ${psSingleQuote(commandLine)}`,
    `$log = Join-Path $env:TEMP 'pi-purge-desktop.log'`,
    "function Log($m) { try { Add-Content -LiteralPath $log -Value (((Get-Date).ToUniversalTime().ToString('o')) + ' [pi-purge] ' + $m) -Encoding utf8 } catch {} }",
    "try {",
    "  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }",
    "  Log ('wmi create ReturnValue=' + $r.ReturnValue + ' pid=' + $r.ProcessId)",
    "  if (-not $r -or $r.ReturnValue -ne 0) { throw ('Win32_Process.Create ' + $r.ReturnValue) }",
    "} catch {",
    "  Log ('wmi create failed, start-process fallback: ' + $_)",
    `  Start-Process -FilePath 'powershell.exe' -ArgumentList @(${argList}) -WindowStyle Hidden`,
    "}",
  ].join("\r\n");
  real.writeFileSync(launcherPs1, body, "utf8");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", launcherPs1],
      { timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    const detail = [err?.message, err?.stderr && String(err.stderr)].filter(Boolean).join(" ");
    logInternal("wmi launcher exec failed: " + detail);
    spawn("powershell.exe", psArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    }).unref();
  }
}

export function waitForFile(fp, ms) {
  const real = diskFs();
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    try { if (real.existsSync(fp)) return true; } catch { /* 还没写上 */ }
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    } catch {
      const spin = Date.now() + 50;
      while (Date.now() < spin) { /* idle */ }
    }
  }
  return false;
}

const ASAR_SWAP_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][int]$WaitPid,",
  "  [Parameter(Mandatory = $false)][int]$ShellPid = 0,",
  "  [Parameter(Mandatory = $false)][string]$AsarPath = '',",
  "  [Parameter(Mandatory = $true)][string]$ExePath,",
  "  [Parameter(Mandatory = $false)][string]$AlivePath = ''",
  ")",
  "$ErrorActionPreference = 'Continue'",
  "if ($AlivePath) { try { Set-Content -LiteralPath $AlivePath -Value $PID -Encoding ascii } catch {} }",
  "try { Add-Content -LiteralPath (Join-Path $env:TEMP 'pi-purge-desktop.log') -Value (((Get-Date).ToUniversalTime().ToString('o')) + ' [pi-purge] asar swap helper running pid=' + $PID + ' wait=' + $WaitPid + ' shell=' + $ShellPid) -Encoding utf8 } catch {}",
  "$exeNorm = $ExePath.ToLower().Replace('/','\\')",
  START_DESKTOP_GUI_PS,
  "function Stop-Pid([int]$id) {",
  "  if ($id -le 0) { return }",
  "  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue",
  "}",
  "function Test-SkipCmd([string]$cl) {",
  "  if (-not $cl) { return $false }",
  "  $n = $cl.ToLower().Replace('\\','/')",
  "  if ($n -match 'restart-web\\.js|restart-desktop\\.js|pi-purge-asar-swap|pi-purge-wmi-launch') { return $true }",
  "  return $false",
  "}",
  "function Test-HostCmd([string]$cl) {",
  "  if (-not $cl) { return $false }",
  "  $n = $cl.ToLower().Replace('\\','/')",
  "  if ($n -match 'dsh-desktop-host|host-process-entry|desktop-cli\\.js') { return $true }",
  "  if ($n -match 'bin\\.js') { return $true }",
  "  return $false",
  "}",
  "function Stop-ByExe([bool]$skipHost) {",
  "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "    $ep = $_.ExecutablePath",
  "    if (-not $ep) { return $false }",
  "    if ($ep.ToLower().Replace('/','\\') -ne $exeNorm) { return $false }",
  "    $cl = [string]$_.CommandLine",
  "    if (Test-SkipCmd $cl) { return $false }",
  "    if ($skipHost -and (Test-HostCmd $cl)) { return $false }",
  "    return $true",
  "  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  "}",
  "function Stop-GuiFirst { Stop-ByExe $true }",
  "function Stop-ExeOnly { Stop-ByExe $false }",
  "$goPath = if ($AlivePath) { $AlivePath + '.go' } else { '' }",
  "if ($goPath) {",
  "  for ($i = 0; $i -lt 50; $i++) {",
  "    if (Test-Path -LiteralPath $goPath) { break }",
  "    Start-Sleep -Milliseconds 100",
  "  }",
  "} else {",
  "  Start-Sleep -Milliseconds 800",
  "}",
  "# 先杀 GUI。先杀 host 时官方未打 #83 的 main.js 会弹 dsh desktop host stopped。",
  "Stop-GuiFirst",
  "Start-Sleep -Milliseconds 200",
  "Stop-Pid $WaitPid",
  "Stop-Pid $ShellPid",
  "Stop-ExeOnly",
  "Start-Sleep -Milliseconds 800",
  "if (-not $AsarPath) {",
  "  Start-DesktopGui $ExePath",
  "  exit 0",
  "}",
  "$appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "$unpacked = $AsarPath + '.unpacked'",
  "$marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {",
  "  & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "}",
  "$moved = -not (Test-Path -LiteralPath $AsarPath)",
  "if (Test-Path -LiteralPath $AsarPath) {",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  for ($i = 0; $i -lt 80; $i++) {",
  "    try {",
  "      Move-Item -LiteralPath $AsarPath -Destination $bak -Force",
  "      $moved = $true",
  "      break",
  "    } catch {",
  "      if ($i -eq 20 -or $i -eq 50) { Stop-Pid $ShellPid; Stop-ExeOnly; Start-Sleep -Seconds 1 }",
  "      Start-Sleep -Milliseconds 400",
  "    }",
  "  }",
  "}",
  "$lock = $AsarPath + '.rename-pending'",
  "if ($moved) {",
  "  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
  "} else {",
  "  Set-Content -LiteralPath $lock -Value ((Get-Date).ToString('o')) -Encoding ascii",
  "  try { Add-Content -LiteralPath (Join-Path $env:TEMP 'pi-purge-desktop.log') -Value (((Get-Date).ToUniversalTime().ToString('o')) + ' [pi-purge] asar move failed, relaunching sealed app') -Encoding utf8 } catch {}",
  "}",
  "Start-DesktopGui $ExePath",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$AsarPath,",
  "  [Parameter(Mandatory = $true)][string]$ExePath,",
  "  [Parameter(Mandatory = $true)][string]$LockPath",
  ")",
  "$ErrorActionPreference = 'Continue'",
  START_DESKTOP_GUI_PS,
  "$deadline = (Get-Date).AddMinutes(30)",
  "while ((Get-Date) -lt $deadline) {",
  "  $restartFlag = Join-Path $env:TEMP 'pi-purge-official-restarting'",
  "  if (Test-Path -LiteralPath $restartFlag) {",
  "    $flagAge = (Get-Date) - (Get-Item -LiteralPath $restartFlag).LastWriteTime",
  "    if ($flagAge.TotalSeconds -ge 0 -and $flagAge.TotalSeconds -lt 45) { exit 0 }",
  "    Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue",
  "  }",
  "  $exeNorm = $ExePath.ToLower()",
  "  $holding = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "    $ep = $_.ExecutablePath",
  "    if (-not $ep) { return $false }",
  "    if ($ep.ToLower() -ne $exeNorm) { return $false }",
  "    $cl = [string]$_.CommandLine",
  "    if (-not $cl) { return $true }",
  "    $n = $cl.ToLower().Replace('\\','/')",
  "        if ($n -match 'restart-web\\.js|restart-desktop\\.js|pi-purge-asar-swap') { return $false }",
    "    if ($n -match 'dsh-desktop-host|host-process-entry|desktop-cli\\.js') { return $false }",
    "    if ($n -match 'bin\\.js') { return $false }",
    "    return $true",
  "  })",
  "  if ($holding.Count -gt 0) { Start-Sleep -Milliseconds 500; continue }",
  "  if (-not (Test-Path -LiteralPath $AsarPath)) {",
  "    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "    exit 0",
  "  }",
  "  $appDir = Join-Path (Split-Path -Parent $AsarPath) 'app'",
  "  $unpacked = $AsarPath + '.unpacked'",
  "  $marker = Join-Path $appDir 'dsh\\node_modules\\node-addon-require-builtin-win32-x64-msvc\\prebuilt\\win32-x64-msvc-napi-v9.node'",
  "  if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {",
  "    & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null",
  "  }",
  "  $bak = \"$AsarPath.bak\"",
  "  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }",
  "  try {",
  "    Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop",
  "  } catch {",
  "    Start-Sleep -Milliseconds 400",
  "    continue",
  "  }",
  "  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "  Start-DesktopGui $ExePath",
  "  exit 0",
  "}",
  "Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue",
  "",
].join("\r\n");

const ASAR_RENAME_WHEN_IDLE_SH = [
  "#!/bin/sh",
  "asar=$1",
  "exe=$2",
  "lock=$3",
  "deadline=$(($(date +%s) + 1800))",
  "relaunch() {",
  "  unset ELECTRON_RUN_AS_NODE",
  "  case \"$(uname -s)\" in",
  "    Darwin)",
  "      case \"$exe\" in",
  "        */Contents/MacOS/*)",
  "          bundle=$(dirname \"$(dirname \"$(dirname \"$exe\")\")\")",
  "          open \"$bundle\"",
  "          return",
  "          ;;",
  "      esac",
  "      ;;",
  "  esac",
  "  nohup \"$exe\" >/dev/null 2>&1 &",
  "}",
  "app_running() {",
  "  ps -Ao command= 2>/dev/null | grep -F \"$exe\" | grep -v \"pi-purge-asar-rename-when-idle\" | grep -v grep >/dev/null",
  "}",
  "while [ \"$(date +%s)\" -lt \"$deadline\" ]; do",
  "  if [ ! -e \"$asar\" ]; then",
  "    rm -f \"$lock\"",
  "    exit 0",
  "  fi",
  "  if app_running; then",
  "    sleep 1",
  "    continue",
  "  fi",
  "  bak=\"$asar.bak\"",
  "  rm -f \"$bak\"",
  "  if mv \"$asar\" \"$bak\" 2>/dev/null; then",
  "    rm -f \"$lock\"",
  "    relaunch",
  "    exit 0",
  "  fi",
  "  sleep 1",
  "done",
  "rm -f \"$lock\"",
  "exit 1",
  "",
].join("\n");

/** 官方壳开着时 app.asar 被占用。不结束进程，等用户退出后再改名并重新打开。 */
export function scheduleAsarRenameWhenIdle({ exe, asar } = {}) {
  if (!exe || !asar) return { pending: false };
  const lock = `${asar}.rename-pending`;
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age >= 0 && age < 30 * 60 * 1000) return { pending: true, already: true };
    // age<0 时钟回拨或 age>=30min stale，视为失效，清掉重做。
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  } catch {
    // 没有待处理标记，下面新建。
  }
  fs.writeFileSync(lock, `${Date.now()}\n`, "utf8");
  if (process.platform === "win32") {
    const script = path.join(os.tmpdir(), `pi-purge-asar-rename-when-idle-${restartUniqSuffix()}.ps1`);
    fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_PS1, "utf8");
    spawnPowerShellOutsideJob([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-AsarPath",
      asar,
      "-ExePath",
      exe,
      "-LockPath",
      lock,
    ]);
    return { pending: true };
  }
  const script = path.join(os.tmpdir(), `pi-purge-asar-rename-when-idle-${restartUniqSuffix()}.sh`);
  fs.writeFileSync(script, ASAR_RENAME_WHEN_IDLE_SH, { encoding: "utf8", mode: 0o755 });
  const child = spawn("/bin/sh", [script, asar, exe, lock], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", (err) => {
    try { console.warn("[pi-purge] asar rename idle sh spawn 失败:", err?.message || err); } catch { /* 忽略 */ }
  });
  child.unref();
  return { pending: true };
}

/** 等当前桌面进程退出后把 app.asar 挪走，再启动 exe。解开后的 resources/app 才会被加载。 */
export function scheduleAsarSwapRestart({ exe, asar, waitPid = process.pid, exit = false, runtime = null, ctx = null } = {}) {
  if (!exe) throw new Error("缺少桌面 exe，无法重启");
  asar = asar && asarArchiveIsFile(asar) ? asar : "";
  // 若调用方没显式传 runtime,但传了 ctx —— 自己解析一次。
  // 让启动期自愈路径 (index.js:scheduleApplyRestart / 2004 自愈分支) 透传 ctx 就能走优雅握手。
  if (!runtime && ctx) {
    try { runtime = desktopRuntimeOf(ctx); } catch { /* ignore */ }
  }
  // #64：助手确认活着之后再让宿主退出。助手只停 WaitPid / 外壳 exe，不扫安装目录。
  const gracefulExit = () => {
    if (runtime) {
      logInternal("asar swap: handing off restart to desktopRuntime");
      try {
        Promise.resolve(runtime.requestRestart()).catch((err) => {
          logInternal("desktopRuntime.requestRestart rejected: " + (err?.message || err));
        });
      } catch (err) {
        logInternal("desktopRuntime.requestRestart threw: " + (err?.message || err));
      }
    } else {
      logInternal("asar swap: no runtime handoff, helper already alive");
    }
    // 助手等 .go 再杀。这里只留兜底，避免 HTTP 还没把 restarting 写回面板就被掐掉。
    setTimeout(() => { try { process.exit(0); } catch {} }, 8000);
  };

  if (sealedSwapKind() === "helper") {
    const helper = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
    const alive = path.join(os.tmpdir(), `pi-purge-asar-alive-${process.pid}`);
    try { fs.unlinkSync(alive); } catch { /* 没有上一轮标记 */ }
    try { fs.unlinkSync(`${alive}.go`); } catch { /* 没有上一轮放行 */ }
    spawnHelper(helper, {
      respawn: true,
      killApp: true,
      asar,
      execPath: exe,
      cwd: path.dirname(exe),
      waitPid,
      alivePath: alive,
    }, { exit: false });
    if (!waitForFile(alive, 4000)) {
      logInternal("asar swap helper did not start, keeping app alive");
      return { scheduled: false, error: "换包助手没有启动，应用未退出。请完全退出 Harness 后再点应用。" };
    }
    if (exit !== false) gracefulExit();
    return { scheduled: true, goPath: `${alive}.go` };
  }
  const script = path.join(os.tmpdir(), `pi-purge-asar-swap-${process.pid}.ps1`);
  const alive = path.join(os.tmpdir(), `pi-purge-asar-alive-${process.pid}`);
  try { fs.unlinkSync(alive); } catch { /* 没有上一轮标记 */ }
  try { fs.unlinkSync(`${alive}.go`); } catch { /* 没有上一轮放行 */ }
  diskFs().writeFileSync(script, `\uFEFF${ASAR_SWAP_PS1}`, "utf8");
  const psArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    script,
    "-WaitPid",
    String(waitPid),
    "-ShellPid",
    String(process.ppid || 0),
    "-AsarPath",
    asar,
    "-ExePath",
    exe,
    "-AlivePath",
    alive,
  ];
  logInternal("asar swap: spawning helper via Win32_Process.Create (breakaway from Electron job)");
  spawnPowerShellOutsideJob(psArgs);
  if (!waitForFile(alive, 4000)) {
    logInternal("asar swap WMI miss, cmd start fallback");
    spawn("powershell.exe", psArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    }).unref();
  }
  if (!waitForFile(alive, 3000)) {
    logInternal("asar swap helper did not start, keeping app alive");
    return { scheduled: false, error: "换包助手没有启动，应用未退出。请完全退出 Harness 后再点应用。" };
  }
  if (exit !== false) gracefulExit();
  return { scheduled: true, goPath: `${alive}.go` };
}

/**
 * 点「应用」之后走哪条重启。#64：宿主 requestRestart 在桌面端会空返回，进程不动。
 * Windows 官方包用 PowerShell 结束再打开。Linux / macOS 走 restart-desktop.js。
 */
export function desktopRestartChoice(input = {}) {
  const platform = input.platform || process.platform;
  const exe = input.exe || "";
  const desktopExe = Boolean(exe && isDesktopExecutable(exe));
  const official = Boolean(exe && isOfficialHarnessExecutable(exe));
  if (input.openBrowser === false) return "skip";
  if (platform === "win32" && official) return "windows-official";
  if (desktopExe && input.asarSealed === true) return "asar-swap";
  if (desktopExe) return "helper";
  if (input.hasRuntime) return "request-restart";
  return "helper";
}

/** 密封 asar 要先退出进程才能挪走文件。Windows 用 PowerShell；Linux / macOS 用同一份重启脚本。 */
export function sealedSwapKind(platform = process.platform) {
  return platform === "win32" ? "powershell" : "helper";
}

function officialExeFromProcess() {
  if (isOfficialHarnessExecutable(process.execPath) && isFile(process.execPath)) {
    return path.normalize(process.execPath);
  }
  const resources = process.resourcesPath;
  if (!resources) return "";
  const hit = firstExistingExe([path.dirname(path.normalize(resources))]);
  if (hit && isOfficialHarnessExecutable(hit)) return hit;
  return "";
}

function commandHasBareWeb(command) {
  const args = String(command || "").trim().split(/\s+/);
  return argvHasBareCommand(args, "web");
}

let cachedParentGui = { at: 0, value: false };

function ancestorIsDesktopGui(exe, cmd) {
  if (commandHasBareWeb(cmd)) return false;
  return isOfficialHarnessExecutable(exe) || isDesktopExecutable(exe) || pathLooksDesktop(exe || cmd);
}

/**
 * 沿父进程往上找官方桌面 GUI。
 * 0.2.1 桌面窗口加载的是本机 `dsh web`，中间可能还有一层带 `web` 的 Harness.exe，
 * 只看直接父进程会漏掉真正的 GUI。
 */
export function ancestorLooksDesktopGui(input = {}) {
  if (looksOfficialDesktopHost(input) || detectSurface(input) === "desktop") {
    cachedParentGui = { at: Date.now(), value: true };
    return true;
  }
  const now = Date.now();
  const ttl = cachedParentGui.value ? 8000 : 1000;
  if (cachedParentGui.at && now - cachedParentGui.at < ttl) return cachedParentGui.value;
  let id = Number(input.ppid ?? process.ppid);
  if (!id) {
    cachedParentGui = { at: now, value: false };
    return false;
  }
  let looks = false;
  try {
    if (process.platform === "win32") {
      const script = [
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `$id = ${id}`,
        "$re = 'DeepSeek.*Harness\\.exe$|DSH Desktop\\.exe$'",
        "for ($n = 0; $n -lt 6 -and $id; $n++) {",
        "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue",
        "  if (-not $p) { break }",
        "  $exe = [string]$p.ExecutablePath",
        "  $cmd = [string]$p.CommandLine",
        "  $bareWeb = $cmd -match '(^|[\\s\"''])web([\\s\"'']|$)'",
        "  if ($exe -match $re -and -not $bareWeb) { '1'; exit }",
        "  $id = [int]$p.ParentProcessId",
        "}",
        "'0'",
      ].join("\n");
      const text = execFileSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 1 << 20,
      });
      looks = String(text || "").replace(/^\uFEFF/, "").trim() === "1";
    } else {
      for (let n = 0; n < 6 && id; n += 1) {
        const text = execFileSync("ps", ["-p", String(id), "-o", "ppid=,args="], {
          encoding: "utf8",
          timeout: 2000,
        });
        const line = String(text || "").trim();
        const m = line.match(/^(\d+)\s+(.*)$/);
        if (!m) break;
        const cmd = m[2] || "";
        if (ancestorIsDesktopGui("", cmd)) {
          looks = true;
          break;
        }
        id = Number(m[1]);
      }
    }
  } catch {
    looks = false;
  }
  cachedParentGui = { at: now, value: looks };
  return looks;
}

/** 父进程（或更上层）是桌面 GUI，不是 Terminal / 独立 `dsh web`。 */
export function parentLooksDesktopGui(input = {}) {
  return ancestorLooksDesktopGui(input);
}

let cachedSiblingGui = { at: 0, value: false };

/** 同机还有一个不是 `dsh web` 的官方桌面 GUI。 */
export function siblingDesktopGuiAlive(input = {}) {
  if (looksOfficialDesktopHost(input) || detectSurface(input) === "desktop") {
    cachedSiblingGui = { at: Date.now(), value: false };
    return false;
  }
  const now = Date.now();
  if (cachedSiblingGui.at && now - cachedSiblingGui.at < 8000) return cachedSiblingGui.value;
  const self = Number(input.pid ?? process.pid);
  let alive = false;
  try {
    if (process.platform === "win32") {
      const script = [
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `$me = ${self}`,
        "$re = 'DeepSeek.*Harness\\.exe$|DSH Desktop\\.exe$'",
        "$hit = $false",
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {",
        "  if (-not $_.ExecutablePath -or $_.ExecutablePath -notmatch $re) { return }",
        "  if ([int]$_.ProcessId -eq $me) { return }",
        "  $cmd = [string]$_.CommandLine",
        "  if ($cmd -match '(^|[\\s\"''])web([\\s\"'']|$)') { return }",
        "  $hit = $true",
        "}",
        "if ($hit) { '1' } else { '0' }",
      ].join("\n");
      const text = execFileSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 2 << 20,
      });
      alive = String(text || "").replace(/^\uFEFF/, "").trim() === "1";
    } else {
      const text = execFileSync("ps", ["-ax", "-o", "pid=,args="], {
        encoding: "utf8",
        timeout: 2000,
      });
      for (const line of String(text || "").split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const cmd = m[2] || "";
        if (!pid || pid === self) continue;
        if (commandHasBareWeb(cmd)) continue;
        if (pathLooksDesktop(cmd) || /electron|deepseek[\s._-]*harness/i.test(cmd)) {
          alive = true;
          break;
        }
      }
    }
  } catch {
    alive = false;
  }
  cachedSiblingGui = { at: now, value: alive };
  return alive;
}

export function scheduleRestart(request, ctx, options = {}) {
  // 启动自检会带 openBrowser:false。桌面进程不再因此杀掉自己。
  if (options.openBrowser === false) return { restarting: false, skipped: true };
  const target = options.surface || detectSurface();
  // 内嵌 web 进程 argv 带 web，但仍可能是桌面窗口点的重启。
  if (target !== "desktop") {
    return { restarting: false, skipped: true, error: "not desktop surface" };
  }
  const exe = exeForThisProcess();
  const asar = exe ? appAsarPath(exe) : "";
  logInternal(`desktop restart exe=${exe || "-"} asar=${asar || "-"} execPath=${process.execPath}`);
  // ctx 透传给 restartOfficialHarness → scheduleAsarSwapRestart,让 PowerShell 分支
  // 拿到 desktopRuntime 走 requestRestart 优雅退出,避免宿主误报 crash。
  if (process.platform === "win32" && exe && isOfficialHarnessExecutable(exe)) {
    return restartOfficialHarness({ exe, asar, ctx });
  }
  if (exe && asar && asarArchiveIsFile(asar)) {
    const runtime = desktopRuntimeOf(ctx);
    const swapped = scheduleAsarSwapRestart({ exe, asar, waitPid: process.pid, exit: true, runtime });
    if (swapped && swapped.scheduled === false) {
      return { restarting: false, error: swapped.error, keptAlive: true };
    }
    return { restarting: true, asarSwap: true, goPath: swapped && swapped.goPath };
  }
  const runtime = desktopRuntimeOf(ctx);
  const choice = desktopRestartChoice({
    exe,
    asarSealed: false,
    hasRuntime: Boolean(runtime),
  });
  if (choice === "helper" && exe && isDesktopExecutable(exe)) {
    return spawnDesktopHelperAndWait({
      respawn: true,
      killApp: true,
      execPath: exe,
      cwd: path.dirname(exe),
    });
  }
  if (runtime) {
    // 只走桌面整应用 relaunch，不要 exit Host（那会先把内嵌 web 单独拉起来）。
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop requestRestart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  return spawnDesktopHelperAndWait({ respawn: true, killApp: true });
}

function systemPromptFiles(exe) {
  const appDir = appDirForExecutable(exe);
  if (!appDir) return [];
  return [
    path.join(appDir, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
    path.join(appDir, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
  ].filter((fp) => {
    try { return fs.existsSync(fp); } catch { return false; }
  });
}

function unpackedHostIsClean(exe) {
  const files = systemPromptFiles(exe);
  if (files.length === 0) return false;
  return files.every((fp) => {
    try {
      return hostPromptKeepsInject(fs.readFileSync(fp, "utf8"));
    } catch {
      return false;
    }
  });
}

const OFFICIAL_RESTART_FLAG = "pi-purge-official-restarting";
const OFFICIAL_RESTART_WINDOW_MS = 45000;

/**
 * Windows 官方换包走哪条。
 * #133：不再探测/走 wscript。.js 引擎经常没有，失败后把 PowerShell 一起取消。
 * 没确认脚本已经开始，不把进行中的标记当成成功。
 */
export function planOfficialRestart({ inflightAgeMs, logStarted, logState } = {}) {
  const age = Number(inflightAgeMs);
  const fresh = Number.isFinite(age) && age >= 0 && age < OFFICIAL_RESTART_WINDOW_MS;
  const state = logState || (logStarted === true ? "running" : "none");
  if (fresh && state === "running") return { action: "already" };
  return {
    action: "start",
    kind: "powershell",
    writeInflight: false,
    clearInflight: true,
  };
}

function officialRestartFlagPath() {
  return path.join(os.tmpdir(), OFFICIAL_RESTART_FLAG);
}

function officialRestartLogState(sinceMs) {
  try {
    const log = path.join(os.tmpdir(), "pi-purge-official-restart.log");
    const st = fs.statSync(log);
    if (sinceMs && st.mtimeMs + 1000 < sinceMs) return "none";
    const lines = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    let begin = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/(^|\s)begin$/.test(lines[i])) begin = i;
    }
    if (begin < 0) return "none";
    const tail = lines.slice(begin);
    if (tail.some((line) => /not starting|rename failed/.test(line))) return "aborted";
    if (tail.some((line) => /(^|\s)started$/.test(line))) return "done";
    return "running";
  } catch {
    return "none";
  }
}

/** 点「重启」后结束当前官方客户端，挪开被占用的 app.asar，再自己打开。 */
export function restartOfficialHarness(options = {}) {
  const hinted = options.exe ? path.normalize(String(options.exe)) : "";
  const exe =
    (hinted && isDesktopExecutable(hinted) ? hinted : "") ||
    exeForThisProcess() ||
    "";
  if (!exe) return { restarting: false };
  // ctx 可用时 → 拿 desktopRuntime 透传给 PowerShell 分支:
  // 让宿主 ack 预期的 restart,避免 host 退出被当成 crash 弹对话框。
  const runtime = options.runtime || (options.ctx ? desktopRuntimeOf(options.ctx) : null);
  if (!isOfficialHarnessExecutable(exe)) {
    const asar = options.asar || appAsarPath(exe);
    if (asar && asarArchiveIsFile(asar)) {
      const swapped = scheduleAsarSwapRestart({
        exe,
        asar,
        waitPid: process.pid,
        exit: options.exit !== false,
        runtime,
      });
      if (swapped && swapped.scheduled === false) {
        return { restarting: false, error: swapped.error, keptAlive: true };
      }
      return { restarting: true, asarSwap: true, goPath: swapped && swapped.goPath };
    }
    return { restarting: false };
  }
  // #57：不自动跑官方 installer。宿主版本百花齐放，更新交接由用户自己做；
  // 插件只负责解包/补丁。旧逻辑会在落盘前误判失败并清掉 resources\app。
  if (options.requireClean === true && !unpackedHostIsClean(exe)) {
    return { restarting: false, clean: false };
  }
  const inflight = officialRestartFlagPath();
  let inflightAgeMs = -1;
  let inflightMtime = 0;
  try {
    const st = fs.statSync(inflight);
    inflightAgeMs = Date.now() - st.mtimeMs;
    inflightMtime = st.mtimeMs;
  } catch {
    // 没有进行中的重启。
  }
  const asar = options.asar || appAsarPath(exe);
  const plan = planOfficialRestart({
    inflightAgeMs,
    logState: officialRestartLogState(inflightMtime),
  });
  if (plan.action === "already" || plan.clearInflight) {
    try { fs.unlinkSync(inflight); } catch { /* 残留标记不当成重启成功 */ }
  }
  cleanupLegacyRestartScripts();
  logInternal(asar && asarArchiveIsFile(asar) ? "PowerShell 结束进程并挪开 app.asar" : "PowerShell 结束进程并重新打开");
  try {
    const swapped = scheduleAsarSwapRestart({
      exe,
      asar: asar && asarArchiveIsFile(asar) ? asar : "",
      waitPid: process.pid,
      exit: options.exit !== false,
      runtime,
    });
    if (swapped && swapped.scheduled === false) {
      return { restarting: false, error: swapped.error, keptAlive: true };
    }
    return { restarting: true, asarSwap: true, engine: "powershell", goPath: swapped && swapped.goPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logInternal("PowerShell asar swap failed: " + message);
    return { restarting: false, error: message, keptAlive: true };
  }
}

export function scheduleCleanupRestart({ cleanup = [], ctx } = {}) {
  const src = fileURLToPath(new URL("./restart-desktop.js", import.meta.url));
  const dest = path.join(os.tmpdir(), `pi-purge-uninst-${process.pid}.mjs`);
  fs.copyFileSync(src, dest);
  const runtime = desktopRuntimeOf(ctx);
  if (runtime) {
    spawnHelper(dest, { cleanup, helper: dest, respawn: false }, { exit: false });
    Promise.resolve(runtime.requestRestart()).catch((err) => {
      logInternal("desktop uninstall restart failed: " + (err?.message || err));
    });
    return { restarting: true };
  }
  spawnHelper(dest, { cleanup, helper: dest, respawn: true, killApp: true }, { exit: false });
  return { restarting: true };
}

const CLI_ENTRY_BEGIN = "# pi-purge cli entry begin";
const CLI_ENTRY_END = "# pi-purge cli entry end";
const CLI_ASAR_ENTRY = "app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
// #94:官方桌面版把 dsh host 放在 app.asar.unpacked(见 isAiBase 的 app.asar.unpacked 分支),
// 不在封装的 app.asar 里。stock 启动脚本却写死 app.asar/.../cli.js → Cannot find module。
// 回退链必须是 app.asar → app.asar.unpacked → app/,少了中间这级 macOS 开箱即坏。
const CLI_UNPACKED_ENTRY = "app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";
const CLI_DIR_ENTRY = "app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";

function ensureAppRuntimeSymlink(resources) {
  const appDir = path.join(resources, "app");
  const runtime = path.join(resources, "runtime");
  const link = path.join(appDir, "runtime");
  if (!isDir(appDir) || !isDir(runtime)) return { ok: false, reason: "missing" };
  try {
    if (fs.existsSync(link)) {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) return { ok: true, already: true };
    }
  } catch {
    // create below
  }
  try {
    try {
      fs.rmSync(link, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (process.platform === "win32") {
      fs.symlinkSync("..\\runtime", link, "junction");
      return { ok: true, created: true, type: "junction" };
    }
    fs.symlinkSync("../runtime", link, "dir");
    return { ok: true, created: true, type: "dir" };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function stripShimEntryBlock(text) {
  return text.replace(/# pi-purge cli entry begin[\s\S]*?# pi-purge cli entry end\r?\n?/g, "");
}

function patchOfficialCliShimText(text) {
  if (!text) return { changed: false, text };
  // 老版本已改成 "$entry"、asar 原文不在了,但 BEGIN 标记还在 → 也要进来升级成三级回退。
  if (!text.includes(CLI_ASAR_ENTRY) && !text.includes(CLI_ENTRY_BEGIN)) return { changed: false, text };

  // 先铲掉旧块(可能是两级回退),再把裸 asar 路径归一成 "$entry",最后插入最新三级块,保证幂等升级。
  let next = stripShimEntryBlock(text);
  next = next.replace(
    /"\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js"/g,
    '"$entry"',
  );
  next = next.replace(
    /\$resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js/g,
    '"$entry"',
  );
  if (!next.includes('"$entry"')) return { changed: false, text };

  const block = [
    CLI_ENTRY_BEGIN,
    `entry="$resources/${CLI_ASAR_ENTRY}"`,
    `if [ ! -f "$entry" ]; then entry="$resources/${CLI_UNPACKED_ENTRY}"; fi`,
    `if [ ! -f "$entry" ]; then entry="$resources/${CLI_DIR_ENTRY}"; fi`,
    CLI_ENTRY_END,
    "",
  ].join("\n");
  const insertAt = next.search(/ELECTRON_RUN_AS_NODE=1/);
  if (insertAt >= 0) {
    // 插到该行行首,避免把 `export ELECTRON_RUN_AS_NODE=1` 从中间劈开。
    const lineStart = next.lastIndexOf("\n", insertAt) + 1;
    next = `${next.slice(0, lineStart)}${block}${next.slice(lineStart)}`;
  } else {
    next = `${block}${next}`;
  }

  if (next === text) return { changed: false, text, already: true };
  return { changed: true, text: next };
}

const CMD_ENTRY_BEGIN = "REM pi-purge cli entry begin";
const CMD_ENTRY_END = "REM pi-purge cli entry end";
const CMD_CLI_TAIL = "dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";

function cmdEntryAlreadyGood(text) {
  if (!text.includes(CMD_ENTRY_BEGIN) || !text.includes(CMD_ENTRY_END)) return false;
  if (/set\s+"entry=%entry%"/i.test(text)) return false;
  if (!/set\s+"entry=%~dp0[^"\r\n]*app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  // #94:必须含 app.asar.unpacked 这一级回退,否则判为旧块强制升级。
  if (!/if not exist "%entry%" set "entry=%~dp0[^"\r\n]*app\.asar\.unpacked\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  if (!/if not exist "%entry%" set "entry=%~dp0[^"\r\n]*app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js"/i.test(text)) return false;
  const outside = text.replace(/set\s+"entry=[^"]*"/gi, "");
  if (/app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js/i.test(outside)) return false;
  return /"%entry%"/.test(text);
}

function stripCmdEntryBlock(text) {
  return text.replace(/\r?\n?REM pi-purge cli entry begin[\s\S]*?REM pi-purge cli entry end\r?\n?/gi, "\r\n");
}

function replaceQuotedInsensitive(text, pathValue, replacement) {
  const needle = `"${pathValue}"`;
  const lower = text.toLowerCase();
  const want = needle.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(want, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at) + replacement;
    i = at + needle.length;
  }
  return out;
}

/** Windows 官方 dsh.cmd 用 %~dp0，没有 %resources%。先改原文，再插入回退，避免正则改到刚插入的行。 */
export function patchOfficialCliCmdText(text) {
  if (!text) return { changed: false, text };
  const hasAsar = text.toLowerCase().includes("app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js")
    || text.includes(CLI_ASAR_ENTRY);
  const hasMarker = text.includes(CMD_ENTRY_BEGIN);
  if (!hasAsar && !hasMarker) return { changed: false, text };
  if (cmdEntryAlreadyGood(text)) return { changed: false, text, already: true };

  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  // 先从原文(含旧块的 set 行)取 %~dp0 前缀,这样两级旧块也能升级成三级。
  const found = text.match(/%~dp0[^"\r\n]*?app\.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli\.js/i);
  if (!found) return { changed: false, text };
  const cut = found[0].toLowerCase().indexOf("app.asar\\");
  if (cut < 0) return { changed: false, text };
  const prefix = found[0].slice(0, cut);
  let next = stripCmdEntryBlock(text);
  next = replaceQuotedInsensitive(next, `${prefix}app.asar\\${CMD_CLI_TAIL}`, '"%entry%"');
  next = replaceQuotedInsensitive(next, `${prefix}app.asar.unpacked\\${CMD_CLI_TAIL}`, '"%entry%"');
  next = replaceQuotedInsensitive(next, `${prefix}app\\${CMD_CLI_TAIL}`, '"%entry%"');
  const block = [
    CMD_ENTRY_BEGIN,
    `set "entry=${prefix}app.asar\\${CMD_CLI_TAIL}"`,
    `if not exist "%entry%" set "entry=${prefix}app.asar.unpacked\\${CMD_CLI_TAIL}"`,
    `if not exist "%entry%" set "entry=${prefix}app\\${CMD_CLI_TAIL}"`,
    CMD_ENTRY_END,
    "",
  ].join(nl);
  const insertAt = next.search(/ELECTRON_RUN_AS_NODE=1/);
  if (insertAt >= 0) {
    const lineEnd = next.indexOf("\n", insertAt);
    const at = lineEnd >= 0 ? lineEnd + 1 : next.length;
    next = `${next.slice(0, at)}${block}${next.slice(at)}`;
  } else {
    next = block + next;
  }
  if (/set\s+"entry=%entry%"/i.test(next)) return { changed: false, text };
  if (!/"%entry%"/.test(next)) return { changed: false, text };
  if (!cmdEntryAlreadyGood(next)) return { changed: false, text };
  return { changed: next !== text, text: next };
}

/** 解包 app.asar 后修补官方 CLI：入口回退到 app/，并补 app/runtime → ../runtime。 */
export function repairOfficialCliAfterUnpack(exe = findDesktopAppExecutable()) {
  if (!exe || !isOfficialHarnessExecutable(exe)) return { ok: false, reason: "not_official" };
  const resources = resourcesDirForExecutable(exe);
  if (!resources || !isDir(resources)) return { ok: false, reason: "no_resources" };
  const report = { ok: true, resources, symlink: null, shims: [] };
  report.symlink = ensureAppRuntimeSymlink(resources);
  const shimPaths = [
    path.join(resources, "runtime", "cli", "bin", "dsh"),
    path.join(resources, "runtime", "cli", "bin", "dsh.cmd"),
  ];
  for (const fp of shimPaths) {
    if (!isFile(fp)) {
      report.shims.push({ path: fp, status: "missing" });
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8");
    } catch (e) {
      report.shims.push({ path: fp, status: "read_error", error: String(e && e.message ? e.message : e) });
      continue;
    }
    const patched = fp.toLowerCase().endsWith(".cmd")
      ? patchOfficialCliCmdText(text)
      : patchOfficialCliShimText(text);
    if (!patched.changed) {
      report.shims.push({ path: fp, status: patched.already ? "already" : "skipped" });
      continue;
    }
    try {
      // 原子写之前先存一份 .pi-purge.bak，断电/磁盘满也能回退到官方原文。
      const bak = `${fp}.pi-purge.bak`;
      if (!isFile(bak)) {
        try { atomicCopyFileSync(fp, bak); } catch { /* 写不了 bak 不致命 */ }
      }
      atomicWriteSync(fp, patched.text, "utf8");
      report.shims.push({ path: fp, status: "patched" });
    } catch (e) {
      report.shims.push({ path: fp, status: "write_error", error: String(e && e.message ? e.message : e) });
    }
  }
  return report;
}
