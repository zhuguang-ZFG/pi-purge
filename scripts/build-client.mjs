/**
 * 把 lib/redteam/client.js 抽成可嵌入的工厂片段，
 * 写进 client.js 里的 PI_PURGE_DRILL 标记之间。
 *
 * 用法：node scripts/build-client.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const drillSrc = join(root, "lib", "redteam", "client.js");
const clientPath = join(root, "client.js");

const BEGIN = "/* __PI_PURGE_DRILL_BEGIN__ */";
const END = "/* __PI_PURGE_DRILL_END__ */";
const THEME_BEGIN = "/* __PI_PURGE_THEME_BEGIN__ */";
const THEME_END = "/* __PI_PURGE_THEME_END__ */";

let raw = readFileSync(drillSrc, "utf8").replace(/\r\n/g, "\n");
const sharedThemeJs = readFileSync(join(root, "lib", "ui-theme.js"), "utf8")
	.replace(/\nexport\s*\{[^}]+\};?\s*$/m, "\n")
	.replace(/\r\n/g, "\n");
const fullscreenJs = readFileSync(join(root, "lib", "ui-fullscreen.js"), "utf8")
  .replace(/\nexport\s*\{[^}]+\};?\s*$/m, "\n")
  .replace(/\bexport\s+(?=function|const|let|class)/g, "")
  .replace(/\r\n/g, "\n");
function embedJavaScript(source, markerBegin, markerEnd, script, factoryMarker) {
	const fragment = markerBegin + "\n" + script.trim() + "\n" + markerEnd;
	const previousStart = source.indexOf(markerBegin);
	if (previousStart >= 0) {
		const previousEnd = source.indexOf(markerEnd, previousStart + markerBegin.length);
		if (previousEnd < 0) throw new Error("theme markers out of order");
		return source.slice(0, previousStart) + fragment + source.slice(previousEnd + markerEnd.length);
	}
	const factoryStart = source.indexOf(factoryMarker);
	if (factoryStart < 0) throw new Error("factory marker missing for shared theme");
	const insertAt = source.indexOf("\n", factoryStart) + 1;
	if (insertAt <= 0) throw new Error("factory line missing for shared theme");
	return source.slice(0, insertAt) + fragment + "\n" + source.slice(insertAt);
}
raw = embedJavaScript(raw, THEME_BEGIN, THEME_END, sharedThemeJs, "factory: (require) => {");
raw = embedJavaScript(raw, "/* __PI_PURGE_FULLSCREEN_BEGIN__ */", "/* __PI_PURGE_FULLSCREEN_END__ */", fullscreenJs, "factory: (require) => {");
// Keep authored styles separate while shipping the same dependency-free bundle.
const escapeTemplateCss = (css) => css.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
function embedStyles(source, declaration, marker, css) {
	const cssStart = source.indexOf(declaration);
	if (cssStart < 0) throw new Error("style declaration missing: " + declaration);
	const cssEnd = source.indexOf("\n`", cssStart + declaration.length);
	if (cssEnd < 0) throw new Error("style terminator missing: " + declaration);
	const begin = `/* __${marker}_BEGIN__ */`;
	const end = `/* __${marker}_END__ */`;
	const fragment = begin + "\n" + escapeTemplateCss(css) + "\n" + end;
	const previousStart = source.indexOf(begin, cssStart);
	if (previousStart >= 0 && previousStart < cssEnd) {
		const previousEnd = source.indexOf(end, previousStart);
		if (previousEnd < 0 || previousEnd > cssEnd) throw new Error("style markers out of order");
		return source.slice(0, previousStart) + fragment + source.slice(previousEnd + end.length);
	}
	return source.slice(0, cssEnd) + "\n" + fragment + source.slice(cssEnd);
}
const styleSources = ["workspace-skin.css", "assets-view.css", "collaboration-view.css", "settings-view.css", "skills-view.css", "sessions-view.css", "unified-layout.css", "unified-components.css", "studio-skin.css", "overview-workbench.css", "responsive-dock.css"];
const sharedTheme = readFileSync(join(root, "lib", "ui-theme.css"), "utf8");
const glassSkin = readFileSync(join(root, "lib", "glass-skin.css"), "utf8");
const detailSurfaces = readFileSync(join(root, "lib", "redteam", "detail-surfaces.css"), "utf8");
const workbenchLayout = readFileSync(join(root, "lib", "redteam", "workbench-layout.css"), "utf8");
const productStyles = sharedTheme + "\n\n" + styleSources.map((name) => readFileSync(join(root, "lib", "redteam", name), "utf8")).join("\n\n") + "\n\n" + glassSkin + "\n\n" + detailSurfaces + "\n\n" + workbenchLayout;
raw = embedStyles(raw, "const CSS = `", "DSH_PRODUCT_SKIN", productStyles);
if (readFileSync(drillSrc, "utf8") !== raw) writeFileSync(drillSrc, raw);
const startMark = "factory: (require) => {";
const start = raw.indexOf(startMark);
if (start < 0) throw new Error("cannot find ModuleLoader factory in drill client");
const endMark = "\n    return module.exports\n  },\n})";
const end = raw.lastIndexOf(endMark);
if (end < 0) throw new Error("cannot find factory end in drill client");
let body = raw.slice(start + startMark.length, end);

// 去掉末尾 exports（return 已在 endMark 外）
body = body
	.replace(/\n\s*exports\.apply\s*=\s*apply\s*\n/, "\n")
	.replace(/\n\s*exports\.inject\s*=\s*inject\s*\n/, "\n");

// 替换 apply(ctx)：不再自己注册槽位，只导出 Panel / CSS / 状态
const applyAt = body.lastIndexOf("function apply(ctx) {");
if (applyAt < 0) throw new Error("apply(ctx) not found in drill client");
// apply() 本体没有嵌套函数花括号冲突到 CSS（CSS 在前面），用括号深度即可
let d = 0;
let j = body.indexOf("{", applyAt);
for (; j < body.length; j += 1) {
	const ch = body[j];
	if (ch === "{") d += 1;
	else if (ch === "}") {
		d -= 1;
		if (d === 0) {
			j += 1;
			break;
		}
	}
}
const applyParts = `function applyDrillParts() {
      return { CSS: CSS, Panel: Panel, setUI: setUI, useUI: useUI, isFullWindow: isFullWindow, setDockWidth: setDockWidth };
    }
`;
body = body.slice(0, applyAt) + applyParts + body.slice(j);

const fragment = `${BEGIN}
		// 内嵌演练台（源码在 lib/redteam，已并进本插件）
		const __piPurgeDrill = (() => {
			var module = { exports: {} };
			var exports = module.exports;
${body}
			return applyDrillParts();
		})();
${END}`;

let client = readFileSync(clientPath, "utf8");
client = embedStyles(client, "const PURGE_CSS = `", "DSH_PRODUCT_SHELL", sharedTheme + "\n\n" + readFileSync(join(root, "lib", "product-shell.css"), "utf8") + "\n\n" + glassSkin + "\n\n" + workbenchLayout);
client = embedJavaScript(client, THEME_BEGIN, THEME_END, sharedThemeJs, "factory: (require) => {");
client = embedJavaScript(client, "/* __PI_PURGE_FULLSCREEN_BEGIN__ */", "/* __PI_PURGE_FULLSCREEN_END__ */", fullscreenJs, "factory: (require) => {");
if (!client.includes(BEGIN) || !client.includes(END)) {
	throw new Error("client.js missing drill markers; run patch-client-dock.mjs first");
}
const beginAt = client.indexOf(BEGIN);
const endAt = client.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) throw new Error("drill markers out of order");
client = client.slice(0, beginAt) + fragment + client.slice(endAt + END.length);
writeFileSync(clientPath, client);
console.log("embedded drill client into client.js (" + Buffer.byteLength(fragment) + " bytes fragment)");
