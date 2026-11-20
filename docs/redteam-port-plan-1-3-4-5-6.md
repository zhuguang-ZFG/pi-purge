# 红队上游能力搬入方案（审核稿）

**状态：只出文档，产品代码未改。**  
审核通过之前不得改 `lib/redteam/`、`skills/redteam/`、`client.js`、`presets/redteam/`。

审查修订（对照真实仓库后补锚点，不改方案）：`tools.js` 落盘点从「约 L470」改为 **L460**；`useUI` 初始值补 **L576**；`KnowledgeTab` 传入点补 **L4042**；`FindingsTab` 子页签重定向补 L1576 / L1803–1806 / L1824–1833；未读红点补 `unreadOf` L4004 与 `consoleDigest` L1099–1154；`DEEPSEEK_API_KEY` 判定从开放项改为实测口径（见 6.2）。

对照双方：

- 上游：[Jueze-2019/dsh-redteam-mode](https://github.com/Jueze-2019/dsh-redteam-mode) 本地树 `克隆项目/dsh-redteam-mode-main`，提交 `COMMIT_REMOVED`（`v0.14.0-4`）。实现以 `packages/redteam-bundle/` 为准（与 `packages/redteam-store` / `redteam-tools` / `redteam-ui` 哈希一致）。
- 插件：`pi-purge` **1.1.74**，红队在 `lib/redteam/`、`skills/redteam/`、`presets/redteam/`；浏览器侧真正生效的是根目录 `client.js` 里 `__PI_PURGE_DRILL_*` 嵌入块，源是 `lib/redteam/client.js`。

决策（已拍板）：

| 编号 | 题目 | 动作 |
| --- | --- | --- |
| 1 | 态势页 + 五分区控制台 | **搬** |
| 2 | worker 预设 / 按角色裁工具 | **不搬** |
| 3 | `deepseek-web-intel` | **搬** |
| 4 | `score-coverage` | **搬** |
| 5 | 四段式交付报告 | **搬** |
| 6 | 面板跟随根会话 + 知识库按会话筛 | **搬** |
| 7 | 攻击链 9 技能改 toolkit | **不搬**（继续随包） |
| 8 | 环境适配页 | **不搬掉**（必须留下） |
| 9 | 并装独立红队插件 | **禁止** |
| A–F | 插件已领先的流程修复 | **以插件为准**，合入时不得覆盖 |

---

## 0. 工作区说明（给审核人）

本轮开始时工作区里已经出现过一版未授权试改：

- `lib/redteam/client.js`（+636）
- `lib/redteam/store-core.js`（+782）
- `lib/redteam/ui.js`（+39）
- `lib/redteam/tools.js`（+13）
- `lib/redteam/skill-fixes.js`（+6）
- 未跟踪文件 `skills/redteam/deepseek-web-intel.md`、`skills/redteam/score-coverage.md`

按「先文档、后改代码」已全部还原。`git status` 里红队相关应干净。  
`lib/default-prompt-inject.zh.md` / `.en.md` 是更早的本地未提交修改，**与本次无关，不要动**。

那次试改的方向和本文一致（态势 / 四段式 / 会话绑定 / 两份技能），但没有按 A–F 做保护清单，也没有走 `scripts/build-client.mjs`。审核通过后按本文重做，不要把那份 diff 直接 cherry-pick。

---

## 1. 总原则

1. **按块摘，禁止整文件替换。** `store-core.js`（346KB vs 398KB）、`client.js`（281KB vs 345KB）、`tools.js` 都是「上游多一块、插件也多一块」。整文件覆盖会冲掉 A–F 和环境适配。
2. **包名保持插件自己的。** 上游工具行是 `dsh-redteam-mode/tools`，插件是 `pi-purge/redteam/tools`。抄预设或注释时改包名。浏览器模块 id 保持 `pi-purge`，不要改成 `dsh-redteam-mode`。
3. **数据目录仍是 `$DSH_HOME/redteam`。** 新增的 `sessions.json` 写在这个根下，和现有 `engagements/`、`settings.json`、`config.json` 并列。
4. **改完 `lib/redteam/client.js` 必须跑** `node scripts/build-client.mjs`，把工厂嵌进根目录 `client.js`。只改 `lib/redteam/client.js` 而桌面/Web 不重建，审核人在界面上看不到任何变化。
5. **不要加 worker 预设，不要删环境适配，不要并装上游包。**
6. 上游 `scripts/check-no-confidential.mjs` 是仓库 CI 闸门（演练战绩不得进 git），不是运行时功能，本次不搬。

---

## 2. A–F 保护清单（审核红线）

合入任何上游片段前，先把下列位置标成只读。Code review 必须逐条确认仍在。

### A. 并发预留：无 key 只放最早一条

- **文件：** `lib/redteam/tools.js`
- **函数：** `dropReservation`（约 L301–314）
- **插件行为：** `key === undefined` 时遍历 Map，只 `delete` 时间戳最早的那条。
- **上游行为（不要抄）：** `reservations.delete(rootId)`，整张表一次放光。
- **第二处：** 同文件 `subagent/end` 回调（约 L394–401）也是「只删最早一条」。两处都保持。
- **验收：** 同一根会话预留 2 个名额后，不带 key 调 `redteam_agent_slot action=release`，只少 1 个，另一个还在。

### B. `.env` 认 `export` 和行内 `#`

- **文件：** `lib/redteam/tools.js`，`redteam_preflight` 读 `.env` 的循环（约 L504–511）
- **插件正则：** `/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/`
- **插件额外：** 未加引号的值剥掉 `\s+#.*$`
- **上游（不要抄）：** `/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/`，不认 `export`，不剥注释
- **插件还有：** `mergeConfigEnv` 合并 `platform-config` 的 env。搬 6 时只在 `open/bind` 后加落盘，不要重写这段 preflight。
- **验收：** `$DSH_HOME/.env` 写 `export FOFA_KEY=xxx # 备注`，preflight 认到 key，值不含 `#` 后的字。

### C. IPv6 ×3 兜底：至少两个冒号

- **文件：** `lib/redteam/score-rules.js`，`scoreMultiplierOf`（约 L411–414）
- **插件正则：** `/(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i`
- **上游（不要抄）：** `/(^|\/\/)[0-9a-f]{0,4}:[0-9a-f:]+/i`（一个冒号就命中）
- **本次不改 `score-rules.js`。** 5 只加报告函数，不换计分规则。
- **验收：** 目标 `dc01:389` / `ad01:8080` 的命中倍率仍是 1，不是 3。`[2001:db8::1]` 仍是 ×3。

### D. 攻击链计分带 `enabledOnly`

- **文件：** `lib/redteam/store-core.js`，`scoreChain`（约 L3809）
- **插件：** `evaluateScoreBoard(..., { meta, names, enabledOnly: true })`
- **上游 `scoreChain`（不要抄评估那一行）：** 没传 `enabledOnly`
- **报告侧** `scoreReport`（约 L2734）两边都已经 `enabledOnly: true`，保持。
- **验收：** 停用某个得分点后，面板总分、报告总分、攻击链总分三个数字相同。

### E. preflight 带 `fixes` / `registry_total`，Windows 指环境适配

- **文件：** `lib/redteam/tools.js`，`redteam_preflight` 返回（约 L689–716）
- **必须留下：** `broken[].fixes`、`all_checked.registry_total`、Windows 文案「可在「环境适配」页填写」
- **两边都还没做到：** `ok` 只看点名技能（现在仍看全量 `allBroken`）。本次不改判定口径。
- **3/4 只追加** `SKILL_FIXES` 两个键，不改返回结构。

### F. 角色稿：`sort=priority` + internal 自己做

- **文件：** `lib/redteam/store-core.js` 内嵌 `DEFAULT_PROMPTS`
  - `vuln-scan` 第 0 步（约 L609）：`redteam_asset_query` 必须 `sort=priority`，从 high 打起
  - `exploit` 第 0 步（约 L649）：同样 `sort=priority`
  - `internal`（约 L697、L712）：「你自己做」「叶子节点」；记分用 `central-system`，不用废弃 `core-system`
- **上游 0.14：** 叶子和 `central-system` 已对齐；`vuln-scan` 仍无 `sort=priority`。不要用 `packages/redteam-store/lib/prompts.roles.md` 整份覆盖 `DEFAULT_PROMPTS`。
- **验收：** 新靶标生成的 `engagements/<id>/agents/vuln-scan.md` 含 `sort=priority`；`internal.md` 不含「依次拉起四个角色」。

### 合入时的操作纪律

- 从上游拷函数：只拷新增函数，贴到文件末尾或明确锚点之后。
- 改已有函数：用最小补丁（在 `scoreReport` 的 markdown 段之前加 `if (layout === 'simple') return`；在 `dispatch` 里加 3 个 op）。
- 禁止：`git checkout` 上游整文件、IDE 整文件粘贴、用上游 `tools.js` 的 `dropReservation` / `.env` 循环覆盖。

---

## 3. 改动 6 —— 面板跟随根会话 + 知识库按会话筛

**先做。** 1 的态势页和知识库默认筛选都依赖「当前会话绑定了哪个靶标」。

### 3.1 要解决什么

现在插件 `Panel` 启动时只调 `bootstrap`，用全局 `current` 或名册第一条当靶标（`lib/redteam/client.js` 约 L3889–3895）。左侧切到另一个会话或点开子智能体，右侧演练台不换靶标。知识库 `KnowledgeTab` 首次 `query` 把 `engagement` 置空（约 L2401），全库混在一起。

上游做法：根会话 id → `$DSH_HOME/redteam/sessions.json`；点开子会话时 host 侧 `resolveRootSessionId` 沿 `header.parentSession` 走到根；知识库默认筛 `boundEng`。

### 3.2 需要改的文件

| 文件 | 动作 |
| --- | --- |
| `lib/redteam/store-core.js` | 加绑定表读写 + 3 个 dispatch op |
| `lib/redteam/tools.js` | `open` / `bind` 成功后写绑定表（**只加调用，不改 A/B/E**） |
| `lib/redteam/ui.js` | 导出 `resolveRootSessionId`，API 请求带 `resolveRoot` |
| `lib/redteam/client.js` | `Panel` 跟随逻辑；`KnowledgeTab` 吃默认靶标 |
| 根目录 `client.js` | 给 `Panel` 传入当前 `sessionId`；改完跑 build |
| 可选测试 | 新建 `scripts/test-redteam-session-bind.mjs`（审核通过后再写） |

### 3.3 store-core：绑定表

抄上游 `packages/redteam-bundle/lib/store-core.js` L1034–1101，贴到插件 `RedteamStore` 的「当前靶标指针」方法附近（插件约 L1020 一带，`setActiveEngagement` 之后）。

**内容（必须按这个形状）：**

```json
{
  "v": 1,
  "agents": {
    "<根会话id>": { "engagement": "<靶标目录名>", "name": "<展示名>", "at": "<ISO时间>" }
  }
}
```

方法：

- `sessionBindingsPath()` → `join(this.root, 'sessions.json')`
- `sessionBindings()` → 读盘容错，缺文件 / 坏 JSON 当空表
- `sessionBinding(sessionId)` → 返回 engagement id 或 `undefined`
- `setSessionBinding(sessionId, engagement, name)`
  - 会话 id 或靶标空 → `false`
  - `dbPathOf(engagement)` 不存在 → `false`（禁止指向已删靶标）
  - 按 `at` 倒序只留 200 条
  - 写失败返回 `false`，不要抛到智能体主路径

**不要**改 `openEngagement(..., { bindCurrent: false })` 的语义。全局 `current` 指针继续存在，仅作无会话时的回落。

### 3.4 store-core：`dispatch` 三个 op

插在 `activateEngagement` 之后、`pocSearch` 之前（插件约 L758）。上游原文在 bundle `store-core.js` L823–864。

1. **`activateEngagement` 补一句（最小补丁）**  
   现有返回保持。若 `req.session` 是非空字符串且激活成功，再 `setSessionBinding(req.session, req.engagement, req.name)`。

2. **`sessionBinding` / `sessionBindings`**
   - 入参：`session`（界面点开的会话，可能是子智能体）
   - 若 `req.resolveRoot` 是函数，先解析到根；解析抛错则用原 id
   - 返回：`{ ok, session, root_session, bound, name, current }`
   - `sessionBindings` 额外带 `agents`（已删靶标的条目丢掉）
   - `bound === null` 表示没绑过，面板回落「上次选择 / 名册第一条」

3. **`bindSessionEngagement`**
   - 入参：`session`、`engagement`、`name`
   - 无 session → `{ ok:false, error:'session required' }`
   - 给用户在下拉里手选靶标时写绑定

这 3 个 op **不要**走后面的「没选靶标就 engagement required」分支，必须放在取 `id` 之前。插件现有「没靶标时提示词回默认、写操作中文报错」（L787–807）全部保留。

### 3.5 tools.js：智能体落盘

现有内存 `bindings` Map 不动（会话隔离仍靠它）。

在 `bindingKeyOf` / `bindKeysOf` 附近加：

```js
function recordSessionBinding(store, exec, engagementId, name) {
  if (typeof store.setSessionBinding !== 'function') return
  const { rootId, sessionId } = bindingKeyOf(exec)
  const key = rootId || sessionId
  if (!key) return
  try { store.setSessionBinding(String(key), String(engagementId), name) } catch { /* 面板回落 */ }
}
```

调用点（只加一行）：

- `redteam_engagement_open` 里 `bindings.set` 之后（**L423**；工具定义 L407）
- `redteam_session_bind` 绑成功、`bindings.set` 之后（**L460**；工具定义 L437。上一稿写「约 L470」，偏差 10 行，以本行为准）

禁止改 `dropReservation`、`.env` 循环、preflight 返回值。

### 3.6 ui.js：根会话解析

抄上游 `packages/redteam-ui/lib/index.js` L720–763（bundle `ui.js` 也有同名导出）。

- 导出 `resolveRootSessionId(ctx, sessionId)`
- 沿 `sessions.list()` 的 `header.parentSession` 走，最多 64 层防环
- 父会话已回收：停在最后一个认得的 id，不要返回注册表里不存在的父 id

在 `apply()` 里 `dispatchAsync` 之前（插件约 L1150）：

```js
const withRoot = (typeof request.session === 'string' && request.session)
  ? Object.assign({}, request, { resolveRoot: (sid) => resolveRootSessionId(ctx, sid) })
  : request
sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, withRoot) : skillResult)
```

`handlePlatformOp` / `handleAgentsOp` / `handleUpdateOp` / `handleSkillOp` 的现有分支不动（环境适配、技能兜底、更新按钮都在这里）。

### 3.7 client.js：Panel 跟随

参考上游 `packages/redteam-bundle/lib/client.js` L1235–1260、L4668–5022。不要整段替换 `Panel`：插件 `Panel` 有 `embedded`、`clampRtGeom`、外层 dock，上游没有。

**要加的状态：**

- `boundEng`：本会话落盘绑定
- `following` / `followSource`：`bound` | `title` | `last` | `default`
- `manualPickRef`：记下「手选过的会话 id」。手选后本会话不再自动抢回；**切到别的会话必须重新跟随**（上游修过的缺陷，布尔全局开关不要用）

**跟随优先级（与上游一致）：**

1. `sessionBinding` 返回的 `bound`
2. 会话标题能对上某个靶标名
3. `localStorage['rt-last-engagement']`
4. `bootstrap.current` / 名册第一条

**下拉手选：** 设 `following=false`，`bindSessionEngagement`，`rememberEngagement`。  
**「回到跟随」按钮：** `setEng(boundEng)`。

**知识库：**

- `KnowledgeTab` 定义在 **L2360**；首次 `query` 在 **L2401** 把 `engagement: undefined` 清成全库
- 给 `KnowledgeTab` 增加可选 prop `engagement`（默认筛）
- **L2401** 的 `useEffect` 改用 `props.engagement`，不要再传 `engagement: undefined` 清掉
- 保留现有「全部来源靶标」下拉（L2529 一带），用户能切回全库
- `Panel` 传入点就在 **L4042**，现在是 `h(KnowledgeTab, { refreshKey: refreshKey })`。改成：

```js
else if (st.tab === 'knowledge') body = h(KnowledgeTab, {
  refreshKey: refreshKey,
  engagement: boundEng || eng || '',
})
```

  跟会话绑的靶标，不是手里随便点的那一个。5.8 改页签壳时会经过这几行，一并改，不要漏。

### 3.8 根目录 `client.js` 必须传 session

现在挂载是（约 L8516–8517）：

```js
h(__piPurgeDrill.Panel, { embedded: true })
```

改成传入当前会话 id（同文件已有 `currentSessionId(sessions)`，环境适配门禁约 L8260 在用）：

```js
h(__piPurgeDrill.Panel, { embedded: true, sessionId: currentSid })
```

`currentSid` 的取法与 dock 里其它逻辑一致，随左侧会话切换更新。不传 session 时跟随降级为现在的 `bootstrap.current`，不能崩。

改完 `lib/redteam/client.js` 后：

```text
node scripts/build-client.mjs
```

检查 `__PI_PURGE_DRILL_BEGIN__` / `END` 标记还在、片段能解析。不要手改嵌入块。

### 3.9 改动 6 不需要的东西

- 不改 SQLite schema（绑定在 json，不在库）
- 不加 worker
- 不改 `role-section.js`（子会话角色行继续靠 `redteamRole:`）

---

## 4. 改动 5 —— 四段式交付报告

### 4.1 要解决什么

插件 `scoreReport`（`store-core.js` L2675–3753）在拼完 `items` / `stages` / `summary` 之后，直接写旧版六段 markdown（摘要与对账 → 复现前置 → 攻击链 → 逐条明细 → 得分点说明 → 附录），L3753 一次返回。

上游在同一位置（bundle `store-core.js` L3551–3561）默认走 `layout: 'simple'`，markdown 改由 `renderDeliveryReport` 生成四段：

1. 靶标单位资产证明（只列得分资产，标强/中/待补）
2. 得分汇总表（互联网资产权限 / 边界突破 / 内网资产权限 / 靶标权限）
3. 账号密码凭据权限汇总（默认脱敏）
4. 得分点复现（最短报文/命令、预期回显、缺口）

旧六段要 `options.layout === 'legacy'` 才生成。智能体工具 `redteam_score_report` / `redteam_report` 不传 layout 时拿到四段式。

### 4.2 需要改的文件

| 文件 | 动作 |
| --- | --- |
| `lib/redteam/store-core.js` | `scoreReport` 加 layout 分支；文件末尾追加 `rp*` + `renderDeliveryReport` |
| `lib/redteam/client.js` | `ReportTab` 标题、下载文件名、折叠「详细报告查看」 |
| 根目录 `client.js` | 再跑 `build-client.mjs` |

`report-replay.js`、`score-rules.js`、`schema.js` 不改。

### 4.3 怎么合 `scoreReport`（最小补丁）

**保留整段旧 markdown 拼装（L3321–3753），不要删。** 在「阶段分桶」之后、「`const md = []`」之前插入：

```js
const targetName = (meta && meta.target_name) || id
const layout = options.layout === 'legacy' ? 'legacy' : 'simple'
if (layout === 'simple') {
  return {
    items: items2, stages, summary,
    markdown: renderDeliveryReport(this, id, ordered, targetName, options, summary),
    target: targetName, layout: 'simple',
  }
}
```

`items2` / `ordered` / `stages` / `summary` 的计算（含 `enabledOnly`、截图、复现入口）全部沿用插件现有逻辑。四段式只换 markdown 字符串。

### 4.4 要拷的函数（上游 bundle `store-core.js` L5632 一带到文件近末尾）

这些是 `renderDeliveryReport` 的内部助手，上游用 `function` 声明（不是 class 方法）。原样拷到插件 `store-core.js` **类定义之外、文件末尾**：

`rpOneLine` `rpClipText` `rpClip` `rpBalanceParens` `rpCell` `rpCodeBlock` `rpStatusLabel` `rpAttackPath` `rpHostOfTarget` `rpHostOfRequest` `rpIsHostLike` `rpHostMismatch` `rpTargetPortOf` `rpPortsInText` `rpPortConflict` `rpIsHttpMethodLine` `rpSplitHttpRequests` `rpCleanHttpBlock` `rpValidHttpRequest` `rpTokenize` `rpStepMatchesItem` `rpVulnTargetMismatch` `rpStepScore` `rpSelectSteps` `rpSelectCreds` `rpReplayOf` `rpItemDetailLines` `rpSimpleResult` `rpReplayState` `rpCredMatchesItem` `rpUniqueCreds` `rpSecretOf` `rpAssetProof` `renderDeliveryReport`

`renderDeliveryReport(store, id, items, targetName, options, summary)` 会再读：

- `store.listAssets` / `stats` / `listWebshells` / `listTunnels`
- 条目上已有的 `steps` / `credentials` / `requests` / `shots` / `note`

**抄的时候检查：** 只用插件 `store-core` 已经 export / 类上已有的方法。缺方法就停，不要顺手把上游半个 store 拖进来。插件已有 `listAssets`、`stats`、`listWebshells`、`listTunnels`、`listCredentials`。

凭据默认脱敏：`options.secrets === true` 才出明文。面板下载走默认（脱敏）。这和改动 1 的掩码一致。

### 4.5 ReportTab 界面（属于 1+5 交界，5 做数据、1 做壳）

现有 `ReportTab`（`lib/redteam/client.js` L2053）继续调 `api({ op: 'scoreReport', engagement: eng })`，不传 layout，拿到四段 markdown。

要改的展示：

- 工具条标题改为「红队得分报告（四段式）」
- 下载文件名用靶标中文名（`data.target`），不要 `report-xxx.md` 乱码下划线
- 增加 `<details>`「详细报告查看（资产证明 / 得分汇总 / 凭据汇总 / 得分点复现）」
- 卡片列表可保留（操作员扫一眼）；默认阶段折叠（上游 `collapse.isOpen(..., false)`）
- 复现缺口条数继续用现有 `incomplete` / `gaps`

上游有一个只生成 React 节点、不拼 HTML 的 `Markdown` 组件（bundle `client.js` 文件头 L18–约 L200）。详细预览要用它。插件目前没有。**只拷 Markdown 渲染器，不要连同上游整份 client。**

旧六段回归：测试或调试可 `api({ op:'scoreReport', engagement, layout:'legacy' })`。正式入口不暴露这个按钮，除非审核要求加「导出旧版」。

### 4.6 改动 5 禁止动的位置

- `scoreChain` 的 `enabledOnly: true`（D）
- `DEFAULT_PROMPTS`（F）
- `evaluateScoreBoard` / `applyScoreCaps` / IPv6 正则（C）
- `schema.js` 表结构

---

## 5. 改动 1 —— 态势页 + 五分区控制台

### 5.1 要解决什么

插件现在是 10 个平铺页签，默认「资产测绘」（`lib/redteam/client.js` L4011–4017）。上游一级五分区，默认「态势」。

搬 1 的产品结果：

| 一级 | 二级（插件落地） |
| --- | --- |
| 态势 | `overview`（新页，默认） |
| 资产 | `assets`（默认视图改「下一步」，完整列表第二层） |
| 成果 | `findings`（只留漏洞）、`chain`、`scores`（默认已得分，可切高分缺口） |
| 报告 | `report`（四段式，见第 4 节） |
| 资源 | `sessions`、`artifacts`（新，凭据与文件）、`knowledge`、`skills`、`agents`、**`env`（环境适配，插件保留）** |

旧锚点兼容：`#testing` → 资产；`#attackfiles` / `#prompts` → 对应新页。插件已有 `st.tab === 'testing' | 'attackfiles' | 'prompts'` 分支（L4061、L4066、L4045），保留。

### 5.2 需要改的文件

| 文件 | 动作 |
| --- | --- |
| `lib/redteam/client.js` | CSS + 组件 + 页签壳 |
| 根目录 `client.js` | `build-client.mjs`；确认嵌入后 dock 仍是 `embedded: true` |

`ui.js` 的更新按钮、环境适配 API、技能兜底不改。

### 5.3 从上游拷什么、不拷什么

**拷（按函数名，bundle `client.js`）：**

- CSS：`/* ── 态势总览 */` 一段（约 L871–L1104 一带 `.rt-ov-*`、`.rt-tabs-groups`、`.rt-tab-group`）
- `function OverviewTab`（约 L1388–1568）
- `function SecretText`（凭据掩码）
- `function CredentialList` / `AccessList` / `ArtifactsTab`（约 L2400–2475+）
- `function Markdown`（给详细报告预览，见 4.5）
- `TAB_GROUPS` + 一级/二级渲染（约 L4896–4905）

**不拷 / 必须改写：**

- 上游整个 `Panel`（宽度逻辑、无 `embedded`、无 `clampRtGeom`）
- 上游 `apply()` / 模块 id
- 上游默认无「环境适配」—— 我们把 `env` 放进资源分区
- 上游 `modelSelectionSettings` / worker 文案

**插件必须留下的函数：**

- `EnvTab`（L2631）
- `clampRtGeom` / `defaultRtGeom` / `loadRtGeom`（L3819+）
- `Panel` 的 `embedded` 外壳
- Agents 页里「子会话第一行写 `redteamRole:`」的说明（L1299）

### 5.4 OverviewTab 数据（不新开接口）

`OverviewTab` 只聚合已有 op：

- `scoreChain` → 累计分、五阶段
- `scores` → 当前得分 / 下一步缺口 Top
- `sessions` → WebShell 在线、合法隧道
- `agentsStatus`（已有 `handleAgentsOp`）→ 在跑数 / 上限
- `snapshot.stats` / `snapshot.tests` → 未评资产

点卡片用 `onGo('scores'|'chain'|'sessions'|'assets'|'agents')` 切二级页。不要为态势新写一套计分。

### 5.5 资产测绘：默认「下一步」

插件 `AssetsTab` 现在 `useState('list')`（L780）。改成与上游一致：`useState('next')`，默认「下一步 10 台」；完整列表和高级筛选放第二层（上游 L1575、`showFilters`）。

现有 C 段侧栏、内外网标签、发现时间视图留下。

### 5.6 漏洞战果 vs 凭据与文件

插件 `FindingsTab`（**L1562**）现在子页签：漏洞 / 凭据 / 访问会话 / 攻击文件，凭据「明文直显」。锚点：

| 位置 | 行 | 现在做什么 |
| --- | --- | --- |
| `useState('vulns')` | **L1576** | 子页签状态 |
| `subTabBtn` | **L1796–1806** | 四个钮：`vulns` / `files` / `creds` / `access` |
| 分支渲染 | **L1824–1833** | `files` → `AttackFilesTab`；`creds` → `credSection`；`access` → `accessSection`；否则漏洞表 |

搬 1 之后：

- `FindingsTab` **只留漏洞**（按目标聚合保留）
- 凭据、访问会话、攻击文件 → `ArtifactsTab`
- 凭据用 `SecretText` 默认掩码，复制按钮给原值
- **删掉** L1804–1806 三个钮和 L1824–1833 里 `files` / `creds` / `access` 三支，只留漏洞表
- 旧书签兼容（可选、一行）：`FindingsTab` 增加 `onGo` prop；挂载后若要从旧 hash 进来，在 **L1576 后**加 `useEffect`：当 `subTab` 为 `creds` / `access` / `files` 时 `onGo('artifacts')`。`Panel` 现在没有把 hash 写成 `subTab`，所以默认可以不写这支，删钮即可。若要写，`onGo` 从 5.8 的 `goTab` 传入。

这是 1 的一部分，不是 A–F。审核如果要求凭据继续明文，在本文签字栏写明，实施时去掉 `SecretText`。

### 5.7 得分目标默认「已得分」

上游 `ScoreTab` 默认只列已得分，可切「高分缺口 / 完整列表」（bundle client 约 L3685、L3819）。插件 `ScoreTab` 从 L2832 起。按上游加三个切换，默认已得分。规则分组、启用/停用点的现有能力留下。

### 5.8 页签壳怎么改

把 L4011 的扁平 `tabs` 换成：

```js
const TAB_GROUPS = [
  { key: 'overview', label: '态势', tabs: ['overview'] },
  { key: 'assets', label: '资产', tabs: ['assets'] },
  { key: 'results', label: '成果', tabs: ['findings', 'chain', 'scores'] },
  { key: 'report', label: '报告', tabs: ['report'] },
  { key: 'resources', label: '资源', tabs: ['sessions', 'artifacts', 'knowledge', 'skills', 'agents', 'env'] },
]
```

默认 `tab: 'overview'`：改 **`lib/redteam/client.js` L576** 这一行：

```js
let ui = { open: true, tab: 'assets' }
```

改为 `tab: 'overview'`。`useUI` 定义在 L588，初始 state 来自这份 `ui` 快照。只改 L576，不要另起一套默认值。

未读红点（现有实现，本次不改库）：

| 位置 | 行 | 作用 |
| --- | --- | --- |
| `digestHasNew` | **L3807–3816** | 条数变多或 `at` 更新 → 未读 |
| `digest` state / 轮询 | **L3859、L3970–3977** | 调 `consoleDigest` |
| `unreadOf(tab)` | **L4004–4007** | `digest[tab]` 缺失时直接 `false` |
| 页签 title / 红点 | **L4130–4131** | `unreadOf(t[0])` |
| `consoleDigest` | **store-core.js L1099–1154** | 现有键：`assets` `testing` `agents` `sessions` `findings` `chain` `scores` `report` `attackfiles` `knowledge` `prompts` `skills` |

新页 `overview` / `artifacts` / `env` 不在 `sections` 里。`unreadOf` 对缺失键返回假，红点不会误亮。不要为此改 `consoleDigest`。旧键 `testing` / `attackfiles` / `prompts` 仍可留给旧锚点，不删。

渲染：第一行一级分区，第二行该分区的二级。CSS 用上游 `.rt-tabs-groups`。插件 `.rt-tabs{flex-wrap:nowrap}`（L48）要改成分组后可换行，否则一级加二级会挤爆 embedded dock。

### 5.9 改动 1 禁止动的位置

- `EnvTab` 整页
- `platform-config.js` / `bootstrap-runtime.js`
- `role-section.js`、`anchor-gate.mjs`
- `presets/redteam/agent.cordis.yml`（尤其 `modelSelectionSettings: false`、`redteamRole:` 指挥段）
- 不要出现 `redteam-worker-*`

---

## 6. 改动 3 —— `deepseek-web-intel`

### 6.1 要什么

上游随包技能，公开互联网 Search / Fetch。文件：

- 源：`克隆项目/dsh-redteam-mode-main/packages/redteam-bundle/skills/deepseek-web-intel.md`（14777 字节，与仓库根 `skills/deepseek-web-intel.md` 相同）
- 目标：`skills/redteam/deepseek-web-intel.md`（原样复制，不改正文里的 API 与客户端脚本）

Frontmatter 已有：`name: deepseek-web-intel`，`role: recon`，`enabled: true`。

技能正文包含：

- `POST https://api.deepseek.com/v1/tools/search` 与 `/fetch`
- 零依赖 Python 客户端，结果落 `runs/deepseek-intel/`
- Key 只读 `DEEPSEEK_API_KEY` 或 `$DSH_HOME/.env`
- 纪律：不进内网、不把口令写进 query、抓回内容当不可信数据

### 6.2 还要改什么

| 文件 | 动作 |
| --- | --- |
| `lib/redteam/skill-fixes.js` | `SKILL_FIXES` 增加键（按字母序插在 `credential-attack` 与 `dir-bruteforce` 之间） |
| `lib/redteam/index.js` | **不用改名单。** `installBundledSkills`（L188）同步目录下全部 `.md` |

建议 `SKILL_FIXES` 文案（插件口径，认 `export`）：

```text
配 DEEPSEEK_API_KEY：写进 $DSH_HOME/.env（可带 export）后重启 dsh web。
只用于公开互联网 Search/Fetch，不要把内网地址或口令写进 query。
未配置时该技能显示不可用，不影响其它技能。
```

`skill-availability.js` 判定口径（已实测，不再是开放项）：

- 抽必需 env 的函数是 **`requiredEnvOf`（L63–74）**
- 命中规则：`process.env.X`；`os.environ["X"]` / `os.environ.get("X")` **且后面没有默认值逗号**；`${X:?` 显式必填
- 上游技能正文 L100：`os.environ.get("DEEPSEEK_API_KEY")`（无默认值逗号）→ **会被判为必需**
- 同文件 L87：`os.environ.get("DSH_HOME", "")` 有逗号 → 不算必需（与上游「不要把可选 DSH_HOME 误报」一致）
- 未配 key：该技能 `env-missing` / broken，`SKILL_FIXES` 那句会进 `broken[].fixes`
- `ok` 仍看全量 `allBroken`（E 的现状）。本次 **不改** `requiredEnvOf`，不把 `DEEPSEEK_API_KEY` 特判成可选

验收时按「无 key → 本技能不可用 + 有修法；有 key 并重启 → 可用」勾。不要写成「缺 key 时整个 preflight 仍 ok」。

### 6.3 不需要的东西

- 不改 `tools.js` 工具列表（这是技能，不是 `redteam_*`）
- 不改预设、不加 worker
- 不把 key 写进报告 / 仓库 / 命令行示例以外的占位符

### 6.4 验收

- 插件安装/启动后 `$DSH_HOME/redteam/skills/deepseek-web-intel.md` 存在
- 技能库页能看到这一条
- 未配 key：显示不可用 + 修复文案；配 key 并重启后可用
- 没有 key 时其它技能预检不受这条单独失败的影响（若当前 `ok` 仍看全量 broken，在报告里写明「与 E 现状一致」，不要假装改了）

---

## 7. 改动 4 —— `score-coverage`

### 7.1 要什么

上游随包技能，25 类得分点的识别与证据要求。

- 源：`克隆项目/dsh-redteam-mode-main/packages/redteam-bundle/skills/score-coverage.md`（9926 字节）
- 目标：`skills/redteam/score-coverage.md`（原样复制）

Frontmatter：`name: score-coverage`，`role: exploit`。正文要求先跑 `redteam_score_list`，再按 code 选打法。覆盖网络设备 / 云 / 工控 / 边界等，不只是服务器和 Web。

### 7.2 还要改什么

`lib/redteam/skill-fixes.js` 增加：

```text
纯查阅技能，不依赖外部工具。不可用一般是技能文件缺失 —— 重新安装插件后重启 dsh web。
先跑 redteam_score_list 拿本靶标实际 code，再按本技能选打法。
```

按字母序插在 `recon-pipeline` / `redteam-setup` 附近。

**不要**用这份 md 覆盖 `DEFAULT_PROMPTS`（F）。上游角色稿会写「不确定时加载 score-coverage」；插件角色稿已经写 `central-system` 和 `sort=priority`。最多在 `internal` / `exploit` 稿里加一句「细节见技能 score-coverage」，且必须是最小补丁、保留 `sort=priority`。默认建议：**角色稿一字不改**，只加技能文件。

### 7.3 验收

- 技能库看得到
- 无外部依赖，可用性应为 available（文件在即可）
- 指挥/利用角色用 `skill` 工具能加载

---

## 8. 明确不做

| 项 | 原因 |
| --- | --- |
| 5 个 `worker-*.cordis.yml` | 决策 2。插件继续 `redteamRole:` + 原生 `subagent` |
| `PROFILE_EXCLUDES` / `apply(ctx, config.profile)` | 同上。子会话仍看见 56 个工具 |
| `modelSelectionSettings: true` | 插件锁死换模型（`false`） |
| 把 9 个攻击链技能移出包 | 决策 7 |
| 删除 `EnvTab` / `platform-config.js` / `bootstrap-runtime.js` | 决策 8 |
| 安装或引导安装 `dsh-redteam-mode` | 决策 9，抢同一份 `$DSH_HOME/redteam` |
| 覆盖 A–F 六处 | 决策原文「以插件为主」 |
| 改 `lib/default-prompt-inject.*.md` | 破甲稿，与红队搬入无关 |
| 提交 / 推送 / 打包 tgz | 审核通过并改完代码后再说 |

---

## 9. 实施顺序（审核通过后）

1. **6 的后端**：`store-core` 绑定表 + dispatch op → `tools` 落盘一行 → `ui.js` `resolveRootSessionId`  
   先写/跑一个不启动 UI 的脚本：open 靶标后 `sessions.json` 有根会话键；`resolveRoot` 能从假子会话走到根。
2. **5 的后端**：`scoreReport` 加 simple 分支 + 追加 `rp*` / `renderDeliveryReport`  
   用已有靶标库调 `scoreReport`，看 markdown 是否四段；再传 `layout:'legacy'` 确认旧文还在；对一下停用点的总分（D）。
3. **3、4**：两份 md + `SKILL_FIXES` 两键。与 UI 无关，可与 1 并行。
4. **1 + 6 的前端 + 5 的 ReportTab**：改 `lib/redteam/client.js`，然后 **必须** `node scripts/build-client.mjs`。
5. **根 `client.js` 挂载**：`Panel` 传入 `sessionId`。
6. 桌面端：改完 `lib` 后仍要托盘完全退出再装/开（本仓库既有约束）。Web 装完重启一次 `dsh web`。
7. 按第 11 节验收表打勾。不通过不准打包。

建议一次 PR / 一次本地提交只做上述顺序，不要和破甲、Mac apply、worker 混在一起。

---

## 10. 实施需要什么

### 10.1 材料

- 本仓库当前 `master`（1.1.74，红队文件与 HEAD 一致）
- 本地上游树 `克隆项目/dsh-redteam-mode-main` @ `COMMIT_REMOVED`  
  不要在实施中途 `git pull` 上游，避免对照漂移。
- 对照笔记：`.scratch/diff-redteam-deep.json`、`.scratch/redteam-vs-upstream.md`（10 月 8 日那份部分过时，以本文和 deep json 为准）

### 10.2 环境

- Node ≥ 22.13（`node:sqlite`）
- 能跑 `node scripts/build-client.mjs`
- 一台已有红队靶标数据的本机（`$DSH_HOME/redteam/engagements/<id>/assets.db`），用来看四段式和态势数字
- 可选：`DEEPSEEK_API_KEY` 测技能 3；没有 key 测「不可用」即可
- Windows 桌面或 Mac Web 各验一次环境适配页还在（决策 8）

### 10.3 人力

- 改代码的人必须同时打开：本文、上游对应行、插件对应行。禁止「先整文件拷再修编译错误」。
- 审核人按第 11 节和第 2 节 A–F 逐条勾，不看「差不多齐了」。

---

## 11. 验收清单（审核人勾）

### 禁区

- [ ] 没有新增 `presets/redteam/worker-*.yml`
- [ ] `agent.cordis.yml` 仍是 `redteamRole:` + `modelSelectionSettings: false`
- [ ] `tools.js` 没有 `PROFILE_EXCLUDES`
- [ ] `EnvTab` 还在，资源分区能打开环境适配
- [ ] 未安装 `dsh-redteam-mode`
- [ ] `dropReservation` 无 key 仍只放一条（A）
- [ ] `.env` 仍认 `export` 和行内 `#`（B）
- [ ] `dc01:389` 不会 ×3（C）
- [ ] `scoreChain` 仍传 `enabledOnly: true`（D）
- [ ] preflight 仍有 `fixes`、`registry_total`（E）
- [ ] `vuln-scan` / `exploit` 稿仍有 `sort=priority`（F）
- [ ] `lib/default-prompt-inject.*.md` 未被这次改动碰到

### 6

- [ ] `redteam_engagement_open` 后出现 `$DSH_HOME/redteam/sessions.json`
- [ ] 左侧切到已绑定的另一个会话，演练台靶标跟着换
- [ ] 点开子智能体会话，仍显示父会话那个靶标
- [ ] 没绑过的会话回落到上次选择 / 默认，不报错
- [ ] 手选靶标后本会话不再被自动抢回；再切走再切回会重新跟随
- [ ] 知识库默认是本会话靶标的条目，能切回「全部」

### 5

- [ ] 默认报告 markdown 是四段，不是六段旧目录
- [ ] `layout:'legacy'` 仍能出旧文
- [ ] 凭据在报告里默认脱敏
- [ ] 停用点后报告总分 = 面板总分 = 攻击链总分
- [ ] 下载文件名是靶标中文名

### 1

- [ ] 打开演练台默认在「态势」
- [ ] 一级五个分区；资源里有环境适配、凭据与文件
- [ ] 态势上的累计分、阶段、入口、缺口数字与其它页一致
- [ ] 资产默认「下一步」，能进完整列表
- [ ] 漏洞页不再铺凭据；凭据在「凭据与文件」且默认掩码、能复制原文
- [ ] 得分目标默认已得分，能切高分缺口
- [ ] `node scripts/build-client.mjs` 已跑过，根 `client.js` 嵌入块与 `lib/redteam/client.js` 同步
- [ ] embedded dock（清洗面板里的演练台）布局没被一级+二级页签撑坏

### 3 / 4

- [ ] 两个 md 在包内 `skills/redteam/` 且启动后同步到 `$DSH_HOME/redteam/skills`
- [ ] 技能库看得到；`SKILL_FIXES` 有对应修法
- [ ] 无 key 时 deepseek 技能不可用；有 key 且重启后可用

### 回归

- [ ] 破甲主/子会话注入路径未改
- [ ] 红队开场仍走 `anchor-gate.mjs`（若原先就有）
- [ ] Windows 环境适配仍能写工具路径
- [ ] 托盘完全退出后再开，面板不是旧缓存

---

## 12. 风险与回滚

| 风险 | 为什么会发生 | 挡法 |
| --- | --- | --- |
| 整文件覆盖冲掉 A–F | 上游文件更大，diff 看起来「上游更新」 | 第 2 节红线；禁止 checkout 整文件 |
| 只改了 `lib/redteam/client.js` 界面没变 | 真正加载的是根 `client.js` 嵌入块 | 强制 build-client；审核看嵌入块时间戳/体积 |
| `Panel` 没拿到 `sessionId` | 嵌入挂载忘了传 | 第 3.8 节；不传时必须降级不崩 |
| 四段式漏字段 / 报错 | `renderDeliveryReport` 调用了上游才有的 store 方法 | 先对方法名再拷；用真实靶标库跑一次 |
| 态势数字和攻击链不一致 | Overview 自己算分 | 只读 `scoreChain` / `scores` |
| 技能 3 把 key 写进报告 | 模型乱写 | 技能正文已禁止；修法文案再强调 |
| 与独立红队包抢库 | 用户机器上还装着 `dsh-redteam-mode` | 文档和 README 写清不要并装；本次不改安装器 |

回滚：按文件 `git checkout --` 下列路径即可回到 1.1.74 HEAD：

- `lib/redteam/store-core.js`
- `lib/redteam/tools.js`
- `lib/redteam/ui.js`
- `lib/redteam/client.js`
- `lib/redteam/skill-fixes.js`
- `client.js`（若已 build）
- 删除 `skills/redteam/deepseek-web-intel.md`、`skills/redteam/score-coverage.md`
- 可选：删 `$DSH_HOME/redteam/sessions.json`（不影响事实库）

事实库表结构本次不迁，回滚不需要动 SQLite。

---

## 13. 工作量（供排期）

| 块 | 预估 |
| --- | --- |
| 6 后端 + 单测脚本 | 0.5–1 日 |
| 5 后端（拷函数 + 接 layout） | 0.5–1 日 |
| 3、4 | 0.5 小时 |
| 1 + 前端 5/6 + build | 1.5–2 日（`client.js` 最大，嵌在 dock 里要调样式） |
| 联调 Windows / Web | 0.5 日 |

合计约 3–4 个工作日（一个人、含验收）。不要和 worker（2）绑在同一迭代。

---

## 14. 审核签字

请审核人只回答下面几句（编号即可）：

1. 范围 1/3/4/5/6 + A–F 保护 + 不做 2/7/8/9，是否按此执行？
2. 凭据从「明文直显」改为「默认掩码、复制原文」（1 的一部分），是否同意？
3. 角色稿是否 **一字不改**（只加 `score-coverage` 技能），还是允许在 F 保住的前提下加一句「见 score-coverage」？
4. 报告页是否提供「导出旧六段」按钮，还是只留 API `layout:legacy`？
5. 通过 / 不通过。不通过请标本节章节号。

**默认答案（审查未另批则按此开工）：** 1 按本文执行；2 同意掩码（属于搬 1）；3 角色稿一字不改；4 只留 API `layout:legacy`，面板不放旧版按钮；5 锚点修订后可按第 9 节实施。

审核通过后，再按第 9 节改代码。未通过之前继续保持产品代码不动。
