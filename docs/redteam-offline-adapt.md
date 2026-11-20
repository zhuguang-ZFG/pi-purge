# 内网机适配：红队移植包（不连外网、不要上游仓库）

这份文档是给**只能访问内网**的那台电脑用的。包里已经带齐上游 v0.14.1–0.14.3 里要搬的代码，**不要**再去 GitHub 拉 `dsh-redteam-mode`，也**不要**并装那个独立红队插件。

带过去只需要一个文件：

```
pi-purge-1.1.75.tgz
```

文档、技能、演练台源码都在这个包里。整仓拷贝也可以，效果一样。

和上游哪里不一样、影响是什么：`docs/redteam-inconsistency-essence.md`。内网机按本文装即可，不必对着上游仓库改。

---

## 0. 先在这台能上网的机器确认包是齐的

拷走之前在本仓库根目录跑一次（不访问网络）：

```sh
node scripts/verify-redteam-port.mjs
```

全部 `OK` 再拷 `pi-purge-1.1.75.tgz`。内网机没有 Node 也可以不跑这条，按第 3 节装完用界面验收。

重新打包：

```sh
node scripts/build-client.mjs
node scripts/verify-redteam-port.mjs
npm pack
```

会覆盖根目录的 `pi-purge-1.1.75.tgz`。

---

## 1. 拷到内网机带什么

最少：

| 文件 | 作用 |
| --- | --- |
| `pi-purge-1.1.75.tgz` | 安装用 |
| 本文 `docs/redteam-offline-adapt.md` | 装完对照（tgz 里也有） |

可选对照（都不需要上游源码）：

- `docs/redteam-vs-upstream-0.14.3.md` — 和上游差在哪、故意没搬什么
- `docs/redteam-port-plan-1-3-4-5-6.md` — 当初搬 1/3/4/5/6 的审核口径
- `release-notes.md` — 1.1.75 全部改动

不要带：

- `.scratch/dsh-redteam-mode/`（上游克隆，内网用不上）
- `node_modules/`
- 旧的 `pi-purge-1.1.74.tgz` 等历史包

---

## 2. 内网机前置

- 官方 DeepSeek Harness 已经装好（Web `dsh web` 和/或桌面 EXE）
- 知道正在用的 `$DSH_HOME`（里面有 `profiles/`）
- **不要**已安装 `dsh-redteam-mode`。装过就先卸掉，两套会抢 `$DSH_HOME/redteam`
- 本机 Node ≥ 18 更好（方便跑自检）；没有也能装插件

Windows 桌面 `dsh` 往往不在 PATH，用：

```
<桌面安装根>\resources\runtime\cli\bin\dsh.cmd
```

例如 `D:\DeepseekHarnessDesktop\resources\runtime\cli\bin\dsh.cmd`。便携目录时先：

```powershell
$env:DSH_HOME = "D:\DeepSeek Harness\.dsh"   # 改成实际那份
```

---

## 3. 安装（本地 tgz，不访问外网）

把 tgz 放到内网机任意目录，例如 `C:\temp\pi-purge-1.1.75.tgz`。

**Web：**

```sh
dsh plugin --profile web add C:\temp\pi-purge-1.1.75.tgz
```

**桌面：**

```sh
dsh plugin --profile desktop add C:\temp\pi-purge-1.1.75.tgz
```

`dsh` 不在 PATH 就换成 `dsh.cmd` 全路径。某个 profile 不存在就跳过那条。

命令行装不上时走手动：

1. 解压 tgz（gzip + tar）。解出来一般是 `package/`，把它改名为 `pi-purge`，整夹放到 `$DSH_HOME/plugins/pi-purge`
2. 只**追加**，不要整段覆盖 profile 的 `package.json`：
   - `dependencies` 加 `"pi-purge": "file:../../plugins/pi-purge"`
   - `dsh.profile.bundles` 末尾加 `"pi-purge"`（已有就不要再加）
3. Web 改 `profiles/web/package.json`，桌面改 `profiles/desktop/package.json`

装完必须做：

1. **完全退出再开**刚装的那个宿主：Web 停掉 `dsh web` 再开；桌面退出托盘再开 EXE
2. 会话标题旁点 **pi-purge → 清洗 → 应用**
3. 「应用」成功会再重启一次。Web 按钮只动 Web，桌面只动桌面

技能文件由插件启动时同步到 `$DSH_HOME/redteam/skills`，覆盖同名随包技能。用户自己的副本在 `$DSH_HOME/skills`，这里不动。

---

## 4. 装完界面上该看到什么

打开红队演练台：

| 位置 | 期望 |
| --- | --- |
| 默认页 | **态势**，不是资产测绘 |
| 一级分区 | 态势 / 资产 / 成果 / 报告 / 资源 |
| 资源分区 | 会话隧道、凭据与文件、知识库、技能库、智能体、**环境适配** |
| 技能库 | 能看到 `campaign-planning`、`specialist-paths`、`deepseek-web-intel`、`score-coverage` |
| 报告页 | 有得分时是模板化三块：资产归属证明 → 得分汇总 → 得分点复现 |
| 下载报告 | 文件名带靶标中文，不是一串下划线 |
| 全面浏览 | Web 优先新窗口；桌面同窗全屏，Esc 退出；不要盖住窗口最小化/关闭 |
| 左侧换会话 | 右侧靶标跟着换（绑过的）；子智能体仍显示父会话那个靶标 |

已有靶标的 `engagements/<id>/agents/*.md` **不会自动改**。要带上作战规划句：在智能体页重置提示词，或开新靶标。

---

## 5. 内网机上的离线自检（有 Node 时）

如果拷的是整仓，或已经把插件解到 `plugins/pi-purge`：

```sh
cd $DSH_HOME/plugins/pi-purge
node scripts/verify-redteam-port.mjs
```

再确认技能已经落到数据目录：

```
$DSH_HOME/redteam/skills/campaign-planning.md
$DSH_HOME/redteam/skills/specialist-paths.md
$DSH_HOME/redteam/skills/deepseek-web-intel.md
$DSH_HOME/redteam/skills/score-coverage.md
```

没有这四个文件：再完全退出宿主开一次，让 `installBundledSkills` 同步。还没有，就从包内 `skills/redteam/` 复制过去。

---

## 6. 适配时不要动的位置

这些是插件自己的口径，内网机「对齐上游」时也不要改回去：

- `lib/redteam/tools.js` 的 `dropReservation`（无 key 只放一条）
- 同文件 `.env` 读取（认 `export`、剥行内 `#`）
- `lib/redteam/score-rules.js` 的 IPv6 倍率（至少两个冒号）
- `store-core.js` 里 `scoreChain` / `scoreReport` 的 `enabledOnly: true`
- `vuln-scan` / `exploit` 稿里的 `sort=priority`，`internal` 的 `central-system`
- `presets/redteam/agent.cordis.yml`（`redteamRole:`，不许加 worker，不许开换模型）
- 环境适配页、`platform-config.js`
- 破甲主链路、`lib/default-prompt-inject.*.md`

凭据默认脱敏。要明文：接口传 `secrets: true`，面板下载保持脱敏。

旧六段报告：`scoreReport` 加 `layout: 'legacy'`。面板不放这个按钮。

---

## 7. 包内代码落点（改适配时对着改）

| 能力 | 文件 |
| --- | --- |
| 报告 model / markdown | `lib/redteam/store-core.js`（`buildReportV2`、`renderTemplateReport`、`scoreReport`） |
| 报告页、态势、全面浏览、标题栏 | `lib/redteam/client.js`；改完必须 `node scripts/build-client.mjs`，真正加载的是根目录 `client.js` |
| 会话绑定 | `store-core.js` 的 `sessions.json`；`tools.js` 落盘一行；`ui.js` 的 `resolveRootSessionId` |
| 技能正文 | `skills/redteam/*.md` |
| 技能修法 | `lib/redteam/skill-fixes.js` |
| 角色默认稿 | `store-core.js` 的 `DEFAULT_PROMPTS` |
| 预设 | `presets/redteam/` |

只改 `lib/redteam/client.js` 不重建，桌面/Web 界面不会变。

---

## 8. 和上游的关系（内网机不用再拉）

已经搬进来的：

- 0.14.1 桌面标题栏避让
- 0.14.2 桌面全面浏览同窗全屏
- 0.14.3 模板化报告、`campaign-planning`、`specialist-paths`

故意没搬：worker、按角色裁工具、换模型、把 9 个攻击链技能移出包。

插件多出来的：环境适配、A–F、27 个随包技能（上游 bundle 是 18）。

细节见同目录 `redteam-vs-upstream-0.14.3.md`。

---

## 9. 常见卡住

| 现象 | 处理 |
| --- | --- |
| 技能库没有新技能 | 托盘完全退出再开；或手动把包内 md 拷到 `$DSH_HOME/redteam/skills` |
| 报告还是旧卡片 | 根 `client.js` 没有重建，或装的是旧 tgz。看嵌入块里有没有 `function ReportV2` |
| 角色稿没有规划句 | 旧靶标不会自动改，重置提示词或开新靶标 |
| 和独立红队抢库 | 卸掉 `dsh-redteam-mode` |
| 桌面打不开 / 标题栏被挡 | 确认装的是这份 1.1.75；全面浏览走同窗，Esc 退出 |
| 市场 `already queued` | 不要点市场，只用本地 tgz + 命令行 |

事实库表结构没迁。旧靶标的资产、得分、知识库接着用。
