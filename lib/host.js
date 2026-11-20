import fs from "node:fs";
import { adapterFor, argvHasBareCommand, controlSurface as controlSurfaceOf, detectSurface, looksOfficialDesktopHost, normalizeSurface } from "./surface.js";
import * as desktop from "./desktop.js";
import * as web from "./web.js";

const ADAPTERS = {
  web,
  desktop,
};

export function currentSurface(input) {
  return detectSurface(input);
}

export function isDesktopEmbeddedWeb(input = {}) {
  const argv = input.argv ?? process.argv;
  if (looksOfficialDesktopHost(input) || detectSurface(input) === "desktop") return false;
  if (!argvHasBareCommand(argv, "web")) return false;
  try {
    if (desktop.parentLooksDesktopGui(input)) return true;
  } catch { /* 探测失败就按独立 web */ }
  return false;
}

export function controlSurface(input = {}) {
  const embedded = input.embeddedDesktop === true || (input.embeddedDesktop == null && isDesktopEmbeddedWeb(input));
  return controlSurfaceOf({ ...input, embeddedDesktop: embedded });
}

export function requestedSurface(request, body) {
  // 官方 Host 热路径禁止再拉 PowerShell 扫进程树，否则 GUI 首包 fetch 会 ETIMEDOUT。
  if (looksOfficialDesktopHost() || detectSurface() === "desktop") return "desktop";
  const hint = (body && body.surface)
    || request?.headers?.["x-dsh-surface"]
    || request?.headers?.["x-pi-purge-surface"];
  const ua = String(request?.headers?.["user-agent"] || "");
  const origin = String(request?.headers?.origin || "");
  const electron = /electron/i.test(ua);
  const appOrigin = /^(app|file|dsh):/i.test(origin);
  if (electron || appOrigin) return "desktop";
  return controlSurface({
    hint: normalizeSurface(hint),
    electron,
    embeddedDesktop: false,
  });
}

export function hostAdapter(kind = detectSurface()) {
  return ADAPTERS[adapterFor(kind)] || web;
}

export function scheduleRestart(request, ctx, options = {}) {
  if (looksOfficialDesktopHost() || detectSurface() === "desktop") {
    return hostAdapter("desktop").scheduleRestart(request, ctx, { ...options, surface: "desktop" });
  }
  let kind = options.surface || (request ? requestedSurface(request) : "") || detectSurface();
  return hostAdapter(kind).scheduleRestart(request, ctx, { ...options, surface: kind });
}

export function scheduleCleanupRestart(opts) {
  const kind = opts?.surface || detectSurface();
  return hostAdapter(kind).scheduleCleanupRestart(opts);
}

export function restartNote(kind = detectSurface()) {
  return hostAdapter(kind).restartNote();
}

/** HTTP 先把 restarting:true 写回面板，再放行助手杀进程。 */
export function signalRestartGo(planned) {
  const fp = planned && planned.goPath;
  if (!fp) return;
  try { fs.writeFileSync(fp, "1"); } catch { /* 助手等超时也会自己杀 */ }
}
