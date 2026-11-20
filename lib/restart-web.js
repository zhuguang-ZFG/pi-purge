import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn } from "./core.js";

const encoded = process.env.PI_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

if (info.alivePath) {
  try { fs.writeFileSync(String(info.alivePath), String(process.pid), "utf8"); } catch { /* 宿主只认文件出现 */ }
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

function killOldServer() {
  const pid = Number(info.pid);
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function openBrowser(url) {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitFree() {
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    if (i === 8) killOldServer();
    await new Promise((r) => setTimeout(r, 120));
  }
  killOldServer();
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function webEnv() {
  const env = envForDetachedSpawn(process.env, { surface: "web" });
  env.ELECTRON_RUN_AS_NODE = "1";
  env.DSH_SURFACE = "web";
  env.DSH_PROFILE = "web";
  delete env.PI_PURGE_RESTART;
  return env;
}

const ok = await waitFree();
if (!ok) process.exit(1);

const argv = Array.isArray(info.argv) ? info.argv.slice() : [];
const bin = argv[0] && /[\\/]bin\.js$/i.test(String(argv[0])) ? String(argv[0]) : "";
const cwd = bin ? path.dirname(path.dirname(bin)) : (info.cwd || process.cwd());

let opened = false;
const child = spawn(info.execPath, argv, {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  cwd,
  env: webEnv(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => process.exit(1));
const wantBrowser = info.openBrowser !== false;
const takeUrl = (chunk) => {
  const text = String(chunk || "");
  if (opened) return;
  const match = text.match(/dsh web:\s+(https?:\/\/\S+)/);
  if (!match) return;
  opened = true;
  if (!wantBrowser) return;
  const url = match[1].replace(/[),.;]+$/, "");
  openBrowser(url);
};
child.stdout?.on("data", takeUrl);
child.stderr?.on("data", takeUrl);
child.unref();
if (wantBrowser) {
  const started = Date.now();
  while (!opened && Date.now() - started < 20000) {
    await new Promise((r) => setTimeout(r, 200));
  }
} else {
  await new Promise((r) => setTimeout(r, 1500));
}
process.exit(0);
