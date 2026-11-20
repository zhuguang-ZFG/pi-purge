# 上游红队 v0.14.3 与当前插件对照

对照双方：

- 上游 tag **`v0.14.3`**（`COMMIT_REMOVED`）。移植件已经写进本插件，**内网机不要再拉上游仓库**。
- 插件：`pi-purge` **1.1.75**，红队在 `lib/redteam/`、`skills/redteam/`；浏览器真正加载的是根目录 `client.js` 嵌入块。

本轮已把 0.14.1–0.14.3 里**可搬**的部分合进插件，并按既定方案保住 A–F、环境适配、不装 worker。拿去另一台电脑装：`docs/redteam-offline-adapt.md` + `pi-purge-1.1.75.tgz`。

**不一致的本质、两边现状、影响**（按轴写，不按文件 diff）：`docs/redteam-inconsistency-essence.md`。本文只记对齐清单和本轮改了哪些文件。

---

## 1. 上游这三版加了什么

| 版本 | 主题 | 对插件的意义 |
| --- | --- | --- |
| **0.14.1** | Windows 桌面标题栏避让 | 合入。`.rt-full` / 浮窗 `clampRtGeom` 吃 `--dsh-frame-chrome-top` 等变量，避免盖住最小化/关闭 |
| **0.14.2** | 桌面「全面浏览」不再 `window.open` | 合入。桌面同窗全屏；Web 仍优先新窗口，弹窗被拦则回退同窗 |
| **0.14.3** | 模板化报告 + 作战规划 | 合入。`buildReportV2` / `ReportV2`；技能 `campaign-planning`、`specialist-paths`；角色稿只 prepend 规划句，不整份覆盖 |

0.14.3 报告结构（页面和下载共用同一份 model）：

1. 资产归属证明（互联网 / 内网入口）
2. 得分汇总（互联网 / 边界 / 内网 / 靶标）
3. 得分点复现（按资产、隧道、网段、靶标编）

旧六段仍走 `layout: 'legacy'`，面板不放「导出旧版」按钮。

---

## 2. 已经对齐的部分

这些在更早的 0.14.0 搬入里就已经有，或本轮补齐：

| 能力 | 插件现状 |
| --- | --- |
| 态势页 + 五分区控制台 | 有。默认「态势」；资源区保留「环境适配」 |
| 面板跟随根会话 + `sessions.json` | 有。根 `client.js` 已传 `sessionId` |
| 知识库默认按当前靶标筛 | 有 |
| `deepseek-web-intel` / `score-coverage` | 有 |
| 四段式/模板化报告 | 本轮升到 0.14.3 的 report model |
| 标题栏避让 + 桌面全面浏览 | 本轮合入 |

---

## 3. 本轮实际改了哪些文件

- `lib/redteam/store-core.js`：`buildReportV2` + `renderTemplateReport`；`scoreReport` 默认返回 `report`；角色稿 prepend 规划/专项路径
- `lib/redteam/client.js` + 根 `client.js`（已跑 `node scripts/build-client.mjs`）：`ReportV2`、标题栏、`openFullView`
- `lib/redteam/skill-fixes.js`：两份技能的修法
- `skills/redteam/campaign-planning.md`、`skills/redteam/specialist-paths.md`

未改：`score-rules.js`、`tools.js` 的 A/B/E、`presets/redteam/`、破甲稿、版本号（仍是 1.1.75）。

---

## 4. 故意没搬的差异（插件继续自己的）

| 上游有 / 插件没有 | 原因 |
| --- | --- |
| `worker-*.cordis.yml`、按角色裁工具 | 决策 2。插件继续 `redteamRole:` + 原生 `subagent` |
| `modelSelectionSettings: true` | 插件锁死换模型 |
| 9 个攻击链技能移出包 | 决策 7。插件继续随包：隧道 / 凭据 / 横向 / WebShell / 未授权 / VPS 等 |
| 并装独立 `dsh-redteam-mode` | 决策 9。抢同一份 `$DSH_HOME/redteam` |
| 并发名额改成用户可配 | **运行时已经可配**（`settings.json` + 面板）。差的是人设三份文案仍写死「最多 3」 |
| 资产梳理稿整份重写（每批 50、`assessed=no`） | 查询 API 也没有 `assessed` / `sort=unassessed` / 工具层 `offset`。只 prepend 了 `specialist-paths` |
| 报告默认出明文凭据 | 插件默认脱敏，`secrets: true` 才出明文 |
| 上游 `dropReservation` 一次放光、`.env` 不认 `export` | A/B 以插件为准 |
| IPv6 倍率正则 | C 以插件为准（至少两个冒号） |
| 攻击链 `enabledOnly` | **已对齐**。两边 `scoreChain` / `scoreReport` 都带 `enabledOnly: true` |

---

## 5. 插件多出来的（上游没有或已拿掉）

- **环境适配页**（`EnvTab` + `platform-config.js`），在资源分区
- **A–F 流程修复**：预留只放一条、`.env` 认 `export`/`#`、IPv6 至少两个冒号、攻击链 `enabledOnly`、preflight `fixes`、角色稿 `sort=priority` + `central-system`
- **随包技能 27 个**（上游 bundle 18 个）。多出来的 9 个是攻击链工具箱技能
- 浮窗几何（可拖、可改大小、嵌在清洗面板），不是上游那种贴右侧的 absolute overlay
- 破甲主链路、桌面 host 修复，与红队包无关

---

## 6. 技能清单对照

上游 0.14.3 bundle（18）：

`active-scan` `asset-correlation` `browser-automation` `campaign-planning` `cn-proxy-pool` `deepseek-web-intel` `dir-bruteforce` `fofa-recon` `fscan-intranet` `gogo-intranet` `kimi-webbridge` `nuclei-scan` `passive-recon` `recon-pipeline` `redteam-setup` `score-coverage` `specialist-paths` `web-fingerprint`

插件额外随包（9）：

`chisel-tunnel` `credential-attack` `frp-tunnel` `lateral-movement` `shell-handler` `suo5-tunnel` `unauth-exploit` `vps-reverse-shell` `webshell-toolkit`

---

## 7. A–F 验收（本轮后仍在）

- A `dropReservation` 无 key 只删最早一条
- B `.env` 正则仍认 `export`，并剥行内 `#`
- C `score-rules.js` IPv6 仍是「至少两个冒号」
- D `scoreChain` / `scoreReport` 仍 `enabledOnly: true`（上游 0.14.3 也有，不再算差异）
- E preflight 结构未改
- F `vuln-scan` / `exploit` 仍有 `sort=priority`；`internal` 仍用 `central-system`

---

## 8. 怎么看到变化

技能要同步到 `$DSH_HOME/redteam/skills`：重启一次 `dsh web` 或桌面端（托盘完全退出再开）。新靶标才会带上规划句；已有靶标的 `agents/*.md` 不会自动改，要在智能体页重置提示词。

报告页：有得分记录时走模板化 `ReportV2`；下载文件名保留靶标中文。
