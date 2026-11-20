# 红队「演练台」superagent 化：开发文档

**性质：实现手册，本文描述的功能一律未实现。**
配套的差异分析在 [`redteam-superagent-design.md`](redteam-superagent-design.md)（下称「设计文档」）。

本文的读者是**另一个模型 / 另一个工程师**。所以每一节都写到可以直接下手：
给出文件、函数签名、SQL、伪代码、验收标准，以及**必须避开的坑**（这些坑来自本仓库的真实结构，
不是通用建议）。

---

## 0. 开工前必读

### 0.1 硬约束（违反会导致返工）

| 约束 | 依据 |
| --- | --- |
| 插件版本 `package.json` 保持 `0.0.1`，红队内部标识保持 1.1.75，**不要改** | 仓库约定 |
| 修复必须**跨机器通用**：不许写死本机路径、不许依赖 `D:\DeepSeek Harness` | 仓库约定 |
| 提交前**不要** commit；由维护者决定 | 仓库约定 |
| 不得引入备案查询类能力（历史约定，`regress.mjs` 有守卫） | 仓库约定 |
| 改完必须：`node scripts/build-client.mjs` → 同步两份安装拷贝 → 跑 `.scratch/regress.mjs` | 见 §7 |

### 0.2 两条安装路径（拷贝，不是软链）

```
$DSH_HOME/plugins/pi-purge
$DSH_HOME/profiles/desktop/node_modules/pi-purge
```

改仓库文件后**必须**同步这两处，否则用户看到的是旧代码。`regress.mjs` 的第 [2] 项会逐字节比对。

### 0.3 浏览器生效路径

浏览器加载的是**根目录 `client.js`**。`lib/redteam/client.js` 是它的源，
由 `scripts/build-client.mjs` 把源抽成片段塞进 `client.js` 的
`/* __PI_PURGE_DRILL_BEGIN__ */` … `/* __PI_PURGE_DRILL_END__ */` 之间。

- 改 `lib/redteam/client.js` → **必须**跑 build。
- 改 `client.js` 里 drill 块**外面**的部分（例如 `AttentionToast`、`handleAttention`）→
  直接改 `client.js` 即可（build 不会碰这部分）。
- **但**：如果 drill 块内外各有一份同样的文案（例如按钮文字），两边都要改，
  否则 build 之后两者不一致。

判定某个符号在块内还是块外：

```bash
node -e "const fs=require('fs');const a=fs.readFileSync('client.js','utf8');
const b=a.indexOf('/* __PI_PURGE_DRILL_BEGIN__ */'),e=a.indexOf('/* __PI_PURGE_DRILL_END__ */');
const i=a.indexOf('function handleAttention');console.log(i>b&&i<e?'inside drill':'outside drill')"
```

### 0.4 关键文件地图

| 文件 | 行数量级 | 职责 |
| --- | --- | --- |
| `lib/redteam/store-core.js` | ~7.3k | SQLite 事实库 + 默认提示词 + `dispatch` op 分发 |
| `lib/redteam/schema.js` | ~780 | 全部 DDL + `migrate()` 增量迁移 |
| `lib/redteam/tools.js` | ~2.6k | 67 个智能体工具 + `subagent/end` handler + 名额闸门 |
| `lib/redteam/ui.js` | ~940 | `/redteam/api` HTTP 入口 |
| `lib/redteam/client.js` | ~16k | 演练台面板 bundle（源） |
| `client.js` | ~23k | 外壳 bundle（含 `AttentionToast`、回退、续跑） |
| `lib/tool-gate.js` | ~84 | `tools/pre-execute` / `post-execute` 降级旁路 |
| `lib/redteam/slot-state.js` | ~46 | parked 内存态 |
| `lib/redteam/role-section.js` | ~177 | `redteamRole:` 捕获与角色稿注入 |
| `lib/continue-retry.js` | ~360 | 主会话续跑（含**正确的**插件消息范例） |
| `presets/redteam/agent.cordis.yml` | — | redteam 预设：persona + 工具行 |

---

## 1. 任务 A：配额从「提示词纪律」变成「代码拒绝」

**对应设计文档 §3.2。**
**问题**：`redteam_agent_slot` 只让模型自己别派；模型不听话就没有任何拦截。

### 1.1 现状的精确定位

`lib/redteam/tools.js`

```js
:138  function maxAgentsNow(ctx)                 // settings.json → REDTEAM_MAX_AGENTS → 3
:303  async function liveRunningChildren(ctx, rootSessionId)   // 读 subagents.listChildren
:329  function reservationList(rootId)           // 内存 reservations
:335  function addReservation(rootId, key)
:340  function dropReservation(rootId, key)
:902  name: 'redteam_agent_slot'                 // status / acquire / release
```

`lib/tool-gate.js` 的关键事实（**必须先读**）：

```js
/** pre-execute 的结论只允许 allow；ask / deny / cancel 一律降级。 */
function coerceGate(decision) {
  if (!decision || typeof decision !== "object") return { kind: "allow" };
  return decision.kind === "allow" ? decision : { kind: "allow" };
}
```

它挂在 `tools/pre-execute` 上，`prepend: true`，并且**无条件 next() 之后把结论压成 allow**。
所以：**在这一层返回 deny 是没用的**，会被它吃掉。

### 1.2 实现方案

新文件 `lib/redteam/agent-quota.js`（纯逻辑，无 host 依赖，便于单测）：

```js
/**
 * 子智能体配额判定。纯函数 + 一个注入的「当前在跑数」读取器。
 * 之所以不写在 tools.js 里：tools.js 已经 2600 行，且这一层要能被单测直接 import。
 */
export function quotaDecision({ used, cap, role, isChild }) {
  // 子会话不能再派子会话：maxDepth=1 已经由 subagent 工具本身保证，
  // 这里再挡一次是因为 config 可能被用户改。
  if (isChild) return { kind: 'deny', reason: '子智能体是叶子节点，不允许继续派活（maxDepth=1）' }
  if (used >= cap) return { kind: 'deny', reason: `并发已满（最多 ${cap} 个）：先等现有智能体回报，或 release 掉已结束的` }
  return { kind: 'allow' }
}
```

接入点二选一，**推荐 (a)**：

**(a) 在 `tools/pre-execute` 上另挂一个 handler，排在 tool-gate 之前，并且自己不调 next() 之外的东西**

顺序问题：`tool-gate.js` 用 `prepend: true` 注册，所以它排最外（最后注册的最先跑）。
要在它**内部**生效，红队 handler 必须**比它更晚注册**（即同样 `prepend:true`，
且在 tool-gate 之后 apply），这样红队的是最外层，`next()` 进去才是 tool-gate。

注册时机：`lib/redteam/tools.js` 的 `apply(ctx)` 末尾，用 `ctx.effect` 包住
（参考 `:524` 现有的 `subagent/end` 写法，否则热重载会叠加）。

```js
ctx.effect(() => {
  let install = null
  const hook = async (exec, next) => {
    try {
      if (exec && exec.name === 'subagent') {
        const { rootId, sessionId } = bindingKeyOf(exec)
        const owner = rootId ?? sessionId
        if (owner !== undefined) {
          const live = await liveRunningChildren(ctx, owner)
          const cap = maxAgentsNow(ctx)
          const decision = quotaDecision({
            used: Math.max(live.running, reservationList(owner).length),
            cap,
            isChild: sessionId !== undefined && sessionId !== owner,
          })
          if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
        }
      }
    } catch { /* 判不了就放行：宁可漏拦一次，也不能把派活全堵死 */ }
    return next()
  }
  // 必须晚于 tool-gate 注册才在最外层
  try { install = ctx.on('tools/pre-execute', hook, { global: true, prepend: true }) } catch { /* 无宿主 */ }
  return () => { try { if (typeof install === 'function') install() } catch { /* ignore */ } }
})
```

**坑 1**：`tools/pre-execute` 的 waterfall 语义是「任一层不调 next() 就截断后面所有层」。
所以 deny 必须 `return { kind: 'deny' }` **且不调 next()**，否则下游副作用还会跑。
**坑 2**：`exec.name` 的字段名要先确认。用一次性探针打印一次：

```js
// .scratch/probe-subagent-exec.mjs（临时文件，别提交）
function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (String(exec && exec.name || '').includes('subagent')) {
      console.log('[probe]', Object.keys(exec), exec.name, exec.agent && exec.agent.session && exec.agent.session.id)
    }
    return next()
  }, { global: true })
}
```

**坑 3**：`bindingKeyOf` 在 `tools.js:194`，它读 `exec.agent`。如果 `tools/pre-execute` 的
payload 里 agent 在别的字段，要适配，**不要**假设。

**(b) 备选：把闸门搬进 `subagent` 工具自身**

宿主 `@deepseek-ai/dsh-tool-subagent` 是官方包，改它等于落盘改官方包，违反本仓库的
「去掉对官方包的落盘修改」方向（见 `lib/core.js` 的补丁策略）。**不推荐**。

### 1.3 验收

```js
// .scratch/check-quota.mjs
import { quotaDecision } from '../lib/redteam/agent-quota.js'
const cases = [
  [{ used: 2, cap: 3, isChild: false }, 'allow'],
  [{ used: 3, cap: 3, isChild: false }, 'deny'],
  [{ used: 0, cap: 3, isChild: true }, 'deny'],
]
for (const [input, want] of cases) {
  const got = quotaDecision(input).kind
  console.log(got === want ? '✓' : '✗', JSON.stringify(input), got)
}
```

真机验收：手动把 `settings.json` 的 `maxAgents` 改成 1，跑一次
「派两个互不依赖的任务」，第二个 `subagent` 调用应该返回被拒，**且**第二个子会话
在 `list_agents` 里不存在。

---

## 2. 任务 B：插件消息不得伪装成真人输入

**对应设计文档 §3.3 / §6.5 第 2 条。**

### 2.1 现状

- **正确范例**：`lib/continue-retry.js:128`

```js
export function makeContinueMessage(text) {
  return {
    id: `pi-purge-continue-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: body }],
    source: { kind: "pi-purge", form: "notice", summary: "continue" },
  };
}
```

`hasFreshHumanTurn`（`:246`）据此过滤：`source.kind === "plugin"` 或 `"pi-purge"` 不算真人。

- **错误范例（本次已移除）**：`client.js` 旧 `submitAttentionPrompt` 调 `input.submit('queue')`。
  这条消息在会话日志里是 `source: { kind: "user", rpcId: ... }`，与真人输入**无法区分**。

### 2.2 需要做的事

1. **审计**：找出所有「插件主动往会话里塞消息」的路径。

   ```bash
   grep -rn "input.submit\|\.submit('queue')\|\.submit(\"queue\")\|agent.followup\|agent.steer\|agent.inject" \
     client.js lib/ --include=*.js
   ```

   已知结果（本次修复后）：
   - `lib/continue-retry.js:273` `agent.followup(makeContinueMessage(text))` —— ✅ 带 identity
   - `client.js` 回退（rewind）相关 —— 只写草稿，不发送 —— ✅
   - `client.js` 的 `EnvAdaptSendGate` 包装 `submit` —— 只拦，不发 —— ✅
   - 其余应为空。**若新增了路径，必须用 `makeContinueMessage` 的做法。**

2. **加一条守卫**：在 `client.js` 的回退 / 填充通道里，禁止任何自动 `submit`。

   在 `lib/redteam/client.js` 与 `client.js` 各自的工具函数区（`isPluginDraft` 附近）
   加注释性断言，或直接在 code review 清单里固化。**不要**加运行时抛错 —— 渲染层抛错会白屏。

3. **文档化**：`docs/redteam-superagent-design.md` §6.5 已写，实现时要保证不违背。

### 2.3 验收

```bash
# 应该只出现 continue-retry 一处 followup，且带 source.kind
grep -rn "source: {" lib/continue-retry.js | head
# 应该 0 命中
grep -rn "input.submit(" client.js lib/ --include=*.js
```

真机：触发「填入主会话输入框」后，**输入端应该只有草稿，没有新消息进入对话**。
点发送才应该产生一条 `user/message`。

---

## 3. 任务 C：`agent_task` —— 让「一个任务」成为持久实体

**对应设计文档 §3.4 / §3.5 / §3.6、§5 第二阶段。**
**这是三个阶段里工作量最大的一项，也是唯一能让「重新派任务」真正有意义的前提。**

### 3.1 设计要点（先想清楚再写）

现在：`subagent` spawn 一次 = 一个子会话；子会话结束 = 一切消失，只剩一行 `agent_report`。
重派 = 新 spawn，模型只能靠 `agent_report.summary` 那 1500 字回忆上次干了什么。

目标：**任务（task）持久，执行（assignment）轮次化。**

```
agent_task     一个任务：靶标 + 角色 + 目标摘要 + 状态 + 当前 assignment
agent_report   一次执行轮次的回报（保持现状，加 task_id 外键）
```

**为什么不用 superagent 的 Ticket 全量模型**：
Ticket 的复杂度 80% 在「多来源 + 多人 + 生命周期跨 PR」。红队没有这些。
留下「一个任务有多个执行轮次」这一条就够。

### 3.2 Schema（`lib/redteam/schema.js`）

在 `agent_report` 建表之后追加：

```sql
/* 执行任务：一次「派活」的持久标识。
   子会话是一次性的，任务不是：同一个任务可以有多轮执行（重新派给新子会话）。
   没有这张表，"重新派任务"只能靠模型读上一轮报告的 1500 字摘要回忆。 */
CREATE TABLE IF NOT EXISTS agent_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement TEXT NOT NULL,
  role TEXT NOT NULL,                  -- recon|assess|vuln-scan|exploit|internal
  objective TEXT NOT NULL,             -- 任务目标摘要（模型写，1-3 句）
  scope_note TEXT,                     -- 本次任务的资产/网段范围（自由文本，给下一轮看）
  tried TEXT,                          -- 已试过的路径（JSON 数组，累积）
  status TEXT NOT NULL DEFAULT 'open', -- open|running|waiting|done|dropped
  session_id TEXT,                     -- 当前/最近一轮的子会话 id
  assignment_no INTEGER DEFAULT 0,     -- 第几轮
  outcome TEXT,                        -- done 时的一句话结论
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_agent_task_eng ON agent_task(engagement, status);
CREATE INDEX IF NOT EXISTS ix_agent_task_session ON agent_task(session_id);
```

迁移（`migrate()` 里，紧跟 `ensure('agent_report','acknowledged_at','TEXT')` 之后）：

```js
/* agent_report 挂到任务上；老库保持 NULL（= 未归属），不丢历史 */
ensure('agent_report', 'task_id', 'INTEGER')
```

> 注意：`migrate()` 里的 `ensure` 只做 ALTER，**不建表**。建表走 `migrate()` 末尾那个
> `for (const ddl of [...]) db.exec(ddl)` 循环，或者放进 `DDL` 常量。
> 判断依据：`schema.js:721` 那个数组里就是 `CREATE TABLE IF NOT EXISTS agent_report`，
> **把它加在同一处最省事**。

### 3.3 Store 方法（`lib/redteam/store-core.js`）

放在 `recordAgentReport` 附近（`:1970`）。全部**同步、单事务**，与现有风格一致。

```js
/* ---------- 任务（agent_task）---------- */

/** 开一个任务。返回 task id。 */
openAgentTask(id, f = {}) {
  const db = this.db(id)
  const role = String(f.role || '').trim()
  if (role === '') throw new Error('openAgentTask: role 必填')
  const objective = String(f.objective || '').trim()
  if (objective === '') throw new Error('openAgentTask: objective 必填')
  db.prepare('INSERT INTO agent_task(engagement, role, objective, scope_note, tried, status, created_at, updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?)').run(
    String(id), role, objective.slice(0, 2000),
    f.scope_note === undefined || f.scope_note === null ? null : String(f.scope_note).slice(0, 4000),
    JSON.stringify(Array.isArray(f.tried) ? f.tried : []),
    'open', nowIso(), nowIso(),
  )
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id)
}

/** 把一轮执行挂到任务上（派活时调）。assignment_no 自增。 */
bindAgentTask(id, taskId, sessionId) {
  const db = this.db(id)
  const row = db.prepare('SELECT * FROM agent_task WHERE id = ?').get(Number(taskId))
  if (!row) return { ok: false, error: 'task 不存在' }
  const no = Number(row.assignment_no || 0) + 1
  db.prepare('UPDATE agent_task SET session_id = ?, assignment_no = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(String(sessionId), no, 'running', nowIso(), Number(taskId))
  return { ok: true, task_id: Number(taskId), assignment_no: no }
}

/** 改状态（回报落库时调）。done/dropped 是终态。 */
updateAgentTask(id, taskId, f = {}) {
  const db = this.db(id)
  const statuses = ['open', 'running', 'waiting', 'done', 'dropped']
  const status = f.status === undefined ? undefined : String(f.status)
  if (status !== undefined && !statuses.includes(status)) throw new Error('agent_task status 非法')
  const row = db.prepare('SELECT * FROM agent_task WHERE id = ?').get(Number(taskId))
  if (!row) return { ok: false, error: 'task 不存在' }
  /* tried 只增不减：重派的价值全在这份「已经试过什么」上 */
  let tried = []
  try { tried = JSON.parse(row.tried || '[]') } catch { tried = [] }
  if (Array.isArray(f.add_tried)) for (const item of f.add_tried) if (item && !tried.includes(item)) tried.push(String(item))
  db.prepare('UPDATE agent_task SET status = ?, tried = ?, outcome = ?, updated_at = ? WHERE id = ?').run(
    status === undefined ? row.status : status,
    JSON.stringify(tried.slice(-50)),
    f.outcome === undefined ? row.outcome : String(f.outcome || '').slice(0, 1000),
    nowIso(), Number(taskId),
  )
  return { ok: true, task_id: Number(taskId), status: status === undefined ? row.status : status, tried: tried.slice(-50) }
}

/** 查询：默认只返回未终结的任务。 */
listAgentTasks(id, opts = {}) {
  const db = this.db(id)
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100)
  const rows = opts.include_closed === true
    ? db.prepare('SELECT * FROM agent_task WHERE engagement = ? ORDER BY id DESC LIMIT ?').all(String(id), limit)
    : db.prepare("SELECT * FROM agent_task WHERE engagement = ? AND status NOT IN ('done','dropped') ORDER BY id DESC LIMIT ?").all(String(id), limit)
  return rows.map((r) => ({
    ...r,
    tried: (() => { try { return JSON.parse(r.tried || '[]') } catch { return [] } })(),
  }))
}
```

### 3.4 回报落库时联动（改 `recordAgentReport`）

**只改一处，别到处撒。** 在 `recordAgentReport` 的 INSERT 后面追加：

```js
/* 挂了任务就把任务状态一起推进；没挂就只记回报（老行为不变）。 */
const taskId = Number(f.task_id)
if (Number.isInteger(taskId) && taskId > 0) {
  try {
    const mapped = status === 'ready' ? 'done'
      : status === 'dropped' ? 'dropped'
        : status === 'waiting' || status === 'blocked' || status === 'failed' ? 'waiting'
          : 'running'
    this.updateAgentTask(id, taskId, {
      status: mapped,
      outcome: mapped === 'done' || mapped === 'dropped' ? (f.summary || '') : undefined,
    })
  } catch { /* 任务联动失败不影响回报落库 */ }
}
```

INSERT 的列也要加 `task_id`：

```js
db.prepare('INSERT INTO agent_report(session_id, parent_session, role, label, status, blocked_reason, needs, summary, created_at, task_id) ' +
  'VALUES(?,?,?,?,?,?,?,?,?,?)').run(/* …原参数…, */ Number.isInteger(taskId) && taskId > 0 ? taskId : null)
```

### 3.5 派活路径改造（`lib/redteam/tools.js`）

改 `redteam_agent_slot`（`:902`）的 `acquire` 分支：从「返回一个内存 key」变成「返回 task id」。
**保留旧 key 行为**（兼容还没更新的提示词），新增 `task_id`。

```js
if (args.action === 'acquire') {
  if (free <= 0) { /* …保持现有拒绝… */ }
  const label = (typeof args.label === 'string' && args.label.trim() !== '') ? args.label.trim() : 'slot'
  const bound = bindings.get(owner) ?? bindings.get(String(sessionId))   // 现有绑定查找方式，见 :294 recordSessionBinding
  let taskId = 0
  if (bound !== undefined) {
    try {
      taskId = store.openAgentTask(bound, {
        role: typeof args.role === 'string' ? args.role : 'recon',
        objective: typeof args.objective === 'string' && args.objective.trim() ? args.objective : label,
        scope_note: args.scope_note,
      })
    } catch { taskId = 0 }
  }
  const key = label + '#' + Date.now()
  addReservation(owner, key)
  return JSON.stringify(Object.assign(base, {
    slot: key,
    task_id: taskId || undefined,
    hint: taskId
      ? `已占位（${key}），任务 id=${taskId}。派活时把 task_id 写进子任务第一行注释（redteamTask: ${taskId}），回报会自动挂上去。`
      : `已占位（${key}）。',
  }), null, 2)
}
```

新增参数（`parameters` 里加）：

```js
role: { type: 'string', enum: ['recon', 'assess', 'vuln-scan', 'exploit', 'internal'], description: 'acquire 时：这一轮的角色，用于建任务' },
objective: { type: 'string', description: 'acquire 时：一句话说明这个任务要达成什么' },
scope_note: { type: 'string', description: 'acquire 时：本次的资产/网段范围，给下一轮看' },
task_id: { type: 'number', description: 'release/status 时可指定任务' },
```

### 3.6 子会话怎么知道自己属于哪个任务

**不要**引入第二条正则去解析任务 id —— 角色已经有 `redteamRole:` 这一条了，再加一条会让
「提示词约定」变成「提示词协议」，一错就静默失效（`role-section.js` 的教训）。

**推荐**：在 `role-section.js` 里复用同一个捕获点，把 `redteamRole: <code>` 扩展成可选第二行
`redteamTask: <id>`，**同一次 `agent/inbox/claimed` 里一起读**。

```js
// lib/redteam/role-section.js
const ROLE_TAG = /^[ \t]*redteamRole:[ \t]*(recon|assess|vuln-scan|exploit|internal)[ \t]*$/im
const TASK_TAG = /^[ \t]*redteamTask:[ \t]*(\d+)[ \t]*$/im

export function parseRedteamTask(text) {
  const m = String(text || '').match(TASK_TAG)
  return m ? Number(m[1]) : 0
}
```

`noteClaimedMessage` 里 `remember(agent, role)` 之后追加 `rememberTask(agent, taskId)`，
存进另一个模块级 Map（同样要有 FIFO 上限，照抄 `ROLE_SESSION_CAP` 的做法）。

**然后在 `subagent/end` handler 里读出来**（`tools.js:527`）：

```js
const parsed = text === '' ? null : store.parseAgentReport?.(text)
if (parsed) {
  const taskId = taskIdOfChild(childId)   // 从新 Map 读
  store.recordAgentReport(bound, { /* … */, task_id: taskId || undefined })
}
```

**坑**：`roleBySession` 在 `subagent/end` 时可能已被清理（它按 session id 存，子会话结束后
没有人保证还在）。所以**任务归属要在 `agent/inbox/claimed` 时就落到 `bindings`/一个独立 Map**，
并且 `subagent/end` 里要先读再依赖，读不到就按「未归属任务」处理（不报错、不猜）。

### 3.7 提示词配套

`lib/redteam/store-core.js` 的 `DEFAULT_PROMPTS.plan`（`:540` 附近「并发上限」那一节）追加：

```
- 派活时把 `redteamTask: <task_id>` 单独写一行（跟在 `redteamRole:` 后面），回报会自动挂到这个任务上。
  重新派同一个任务时**复用同一个 task_id**，并在任务描述里贴出该任务的 `tried`（已经试过什么），
  不要让新子会话从零开始。
```

### 3.8 新工具（3 个，`tools.js`）

```js
ctx.tools.register(withStructuredErrors(defineTool({
  name: 'redteam_task',
  description: '【主会话派活/重派时用】任务台账：op=open 开任务、op=list 查未终结任务、op=get 看单个（含 tried）、op=close 收口、op=add_tried 记录已试过的路径。重新派活前先 get 一次，把 tried 贴进新任务描述。',
  parameters: {
    engagement: { type: 'string' },
    op: { type: 'string', required: true, enum: ['open', 'list', 'get', 'close', 'add_tried'] },
    task_id: { type: 'number' },
    role: { type: 'string', enum: ['recon', 'assess', 'vuln-scan', 'exploit', 'internal'] },
    objective: { type: 'string' },
    scope_note: { type: 'string' },
    status: { type: 'string', enum: ['open', 'running', 'waiting', 'done', 'dropped'] },
    outcome: { type: 'string' },
    tried: { type: 'array', items: { type: 'string' } },
    include_closed: { type: 'boolean' },
    limit: { type: 'number' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
  async execute(args, exec) {
    const id = resolveEngagement(store, exec, args.engagement)
    if (args.op === 'open') return JSON.stringify({ ok: true, engagement: id, task_id: store.openAgentTask(id, args) }, null, 2)
    if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, items: store.listAgentTasks(id, args) }, null, 2)
    if (args.op === 'get') {
      const one = store.listAgentTasks(id, { include_closed: true, limit: 200 }).find((t) => t.id === Number(args.task_id))
      return JSON.stringify(one ? { ok: true, task: one } : { ok: false, error: 'task 不存在' }, null, 2)
    }
    if (args.op === 'close') return JSON.stringify(store.updateAgentTask(id, args.task_id, { status: args.status || 'done', outcome: args.outcome }), null, 2)
    return JSON.stringify(store.updateAgentTask(id, args.task_id, { add_tried: args.tried || [] }), null, 2)
  },
})))
```

### 3.9 验收

```js
// .scratch/check-task.mjs  —— 真机库，用完自行清理
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'
const s = new RedteamStore(process.env.DSH_HOME + '/redteam')
const id = 'task-selftest'
const t = s.openAgentTask(id, { role: 'vuln-scan', objective: '测试任务', scope_note: '10.0.0.0/24' })
console.log('open', t)
console.log('bind', s.bindAgentTask(id, t, 'sess-1'))
s.recordAgentReport(id, { session_id: 'sess-1', role: 'vuln-scan', status: 'waiting', blocked_reason: '缺 key', needs: [{ kind: 'key', detail: 'K' }], task_id: t })
console.log('after waiting →', s.listAgentTasks(id))
s.recordAgentReport(id, { session_id: 'sess-2', role: 'vuln-scan', status: 'ready', summary: '干完了', task_id: t })
console.log('after ready   →', s.listAgentTasks(id, { include_closed: true }))
s.close()
```

期望：`waiting` 后任务状态 `waiting`；`ready` 后 `done` 且 `outcome` 非空；
`listAgentTasks` 默认**不再返回**它。

---

## 4. 任务 D：阶段判定表（对齐 `ticketStage`）

**对应设计文档 §3.5。** 工作量小，收益直接（面板与工具共用一份判定）。

新文件 `lib/redteam/task-stage.js`（纯函数，零依赖）：

```js
/**
 * 任务阶段判定。规则来自 superagent 的 ticketStage（src/core/stage.ts），
 * 但红队没有 PR / Channel，所以「跟随外部线程才结束」那条去掉。
 * 从上往下第一个匹配的赢。
 */
export function taskStage(task, latestReport, coverageGaps) {
  if (!task) return 'none'
  if (task.status === 'done') return 'done'
  if (task.status === 'dropped') return 'dropped'
  const r = latestReport && latestReport.status
  if (r === 'waiting') return 'person/answer'
  if (r === 'ready') return 'person/review'
  if (r === 'blocked') return 'person/blocked'
  if (r === 'failed') return 'person/failed'
  if (task.status === 'open' && !task.session_id) return 'working/queued'
  if (r === 'progress') return 'working'
  if (r === 'dropped') return 'dropped'
  /* 没有任何回报但还挂着会话：当它在跑 */
  if (task.session_id) return 'working'
  return Number(coverageGaps) > 0 ? 'working/queued' : 'idle'
}
```

接入：

- `attentionQueue` 里每个 item 的 `stage` 改为 `taskStage(...)` 的结果（保持现有
  `person/*` 字符串不变，**面板与 Toast 的映射表不用改**）。
- `client.js:23050` 的 `AttentionToast`、`lib/redteam/client.js:10457` 的 `STAGE_TEXT`
  已经有 `person/answer|review|blocked|failed|working` 五档；**新增 `working/queued` 与 `idle`
  要两边都补**（否则显示成「等待」）。

### 4.1 验收

```js
import { taskStage } from '../lib/redteam/task-stage.js'
console.log(taskStage({ status: 'running', session_id: 'x' }, { status: 'progress' }, 3)) // working
console.log(taskStage({ status: 'waiting', session_id: 'x' }, { status: 'waiting' }, 0))  // person/answer
console.log(taskStage({ status: 'done' }, null, 0))                                       // done
```

---

## 5. 任务 E：统一边界校验

**对应设计文档 §3.7。** 现状是「2 个入口查、60 多个不查」。

### 5.1 方案

在 `tools.js` 里加一个包装器（`scopeCheck` 已在 `:444`，直接复用）：

```js
/**
 * 所有"写入资产侧事实"的工具都要过这一层。
 * 现状：redteam_batch 会拒 out-of-scope，redteam_asset_add 不会 ——
 * 同一个资产走批量与走单条得到不同结果，这是设计缺陷。
 */
function assertInScope(store, id, target, opts = {}) {
  const check = scopeCheck(store, id, target)
  if (check.status === 'out') {
    throw new Error('超出授权范围：' + target + (check.scope.length ? '（授权范围 ' + check.scope.join(', ') + '）' : '') +
      '。若确认要打，先 redteam_engagement_open 补范围。')
  }
  /* unscoped / unresolved 默认放行：靶标没配范围是常态（提示词明确要求不要追问授权），
     解析不出 IP 的是域名，域名解析属于收集阶段本身要做的事。 */
  return check
}
```

调用点（**逐个确认，不要盲改**）：

| 工具 | 参数里的 target 来源 |
| --- | --- |
| `redteam_asset_add`（`:1000` 附近） | `args.ip` |
| `redteam_vuln_add` / `redteam_vuln_update` | `args.target` |
| `redteam_credential_add` | 无 target，跳过 |
| `redteam_webshell_add`（`:1663`） | `args.url` |
| `redteam_tunnel_add`（`:1720`） | **只查 `entry` 里的 URL 主机**；`listen` 必是本机地址（`127.0.0.1:1080`），`reach` 是 CIDR（`10.0.0.0/8`）——两者都不能直接喂 `scopeCheck` |
| `redteam_score_hit` | `args.target` |
| `redteam_host`（op=finding） | 通过 `asset_id` 反查 IP |

**坑 1**：`redteam_tunnel_add.listen` 是**本机**监听地址，拿它去查范围会把所有隧道全拒掉。
`reach` 是网段字符串不是 IP，`scopeCheck` 对它会返回 `unresolved`（等于不校验）。
所以隧道这一项只能：查 `entry`（若是 URL，取其主机名 → 解析 IP → 查），
并在返回里明确标注 `reach` 未校验。**不要给 `scopeCheck` 加 CIDR 包含逻辑**——
那是另一个语义（网段是否落在授权网段内），会污染现有的 IP 判定。

**坑 2**：`scopeCheck` 对域名返回 `unresolved`。不要为此加 DNS 解析 —— 收集阶段本来就该先解析再落库，
解析失败说明「还没收集到」，此时拒绝反而挡住正常流程。

### 5.2 验收

```
1. 靶标配 scope=10.20.0.0/16
2. redteam_asset_add ip=10.30.1.1   → 应被拒（out）
3. redteam_asset_add ip=10.20.1.1   → 应成功
4. redteam_tunnel_add listen=127.0.0.1:1080 reach=10.30.0.0/16 → 应成功（只查 reach 里的 IP，
   若 reach 是网段字符串而不是 IP，保持现状不查，并在返回里标注「未校验」）
```

---

## 6. 任务 F：报告与库的一致性核对

**对应设计文档 §3.8。** 红队的「成果」天然是计数，所以核对方式是数数。

### 6.1 方案

新工具 `redteam_report_verify`：

```js
name: 'redteam_report_verify',
description: '【主会话核对子智能体回报时用】把某个执行会话声称的成果，与库里它实际写入的行数对一遍：得分命中、漏洞、凭据、WebShell、隧道、主机发现。数字对不上就列出来，不要直接采信报告。'
```

实现要点（**不要**去解析自然语言里的数字 —— 不可靠）：

- 输入：`session_id`（或 `task_id`）、可选 `expect: { score_hits, vulns, credentials, webshells, tunnels, findings }`。
- 统计：按各表自带的「谁写的」列过滤该会话写入的行。
  **列名不统一，必须逐表确认**（这是实测结果，不要凭表名猜）：

  | 表 | 归属列 |
  | --- | --- |
  | `score_hit` | `recorded_by`（`schema.js:209`；`addScoreHit` 在 `store-core.js:2711` 写入） |
  | `vuln` | `agent` |
  | `credential` | `agent` |
  | `webshell` | `agent` |
  | `tunnel` | `agent` |
  | `attack_step` | `agent` 与 `recorded_by` 两列都有（`store-core.js:4985`），统计用 `agent` |
  | `host_finding` | `created_by` |

  若某表在该会话下没有任何行，`actual` 里给 `0` 而不是省略 —— 省略会被读成「没查」。
- 输出：

```json
{
  "ok": true,
  "session_id": "...",
  "actual": { "score_hits": 4, "vulns": 3, "credentials": 1, "webshells": 1, "tunnels": 0, "findings": 12 },
  "expected": { "score_hits": 12, "vulns": 3 },
  "mismatch": [{ "key": "score_hits", "expected": 12, "actual": 4, "note": "报告声称 12 条得分，库里只有 4 条" }],
  "verdict": "mismatch"
}
```

`verdict`: `ok`（全对）/ `mismatch`（有差异）/ `unverifiable`（没给 expected）。

### 6.2 为什么不做自动解析

`agent_report.summary` 是 `text.slice(-1500)` 的自由文本。用正则抽数字会在
「拿到 12 台服务器，其中 3 台是 Windows」这种句子上直接出错。**让模型自己填 `expect`**，
填不上就是 `unverifiable` —— 这比错判好。

### 6.3 验收

- 造 3 条 `score_hit`，然后 `expect: { score_hits: 5 }` → 应返回 `mismatch` 且 `actual=3`。
- 不传 `expect` → `unverifiable`，`actual` 仍然要正确。

---

## 7. 改完必须做的事（每次）

```bash
# 1) 语法
for f in client.js lib/redteam/client.js lib/redteam/store-core.js lib/redteam/tools.js lib/redteam/schema.js; do node --check "$f"; done

# 2) 如果动过 lib/redteam/client.js（或它引入的 css / 共享 js）
node scripts/build-client.mjs

# 3) 同步两份安装拷贝（按需扩展文件清单）
DSH="D:/DeepSeek Harness/.dsh"
for d in "$DSH/plugins/pi-purge" "$DSH/profiles/desktop/node_modules/pi-purge"; do
  for f in client.js lib/redteam/client.js lib/redteam/store-core.js lib/redteam/tools.js lib/redteam/schema.js; do
    cp "$f" "$d/$f"
  done
done

# 4) 回归
DSH_HOME="$DSH" node .scratch/regress.mjs
```

`regress.mjs` 检查项：`node --check`（12 个文件）、两份拷贝逐字节一致、无备案查询引用、技能数 40、
5 个关键模块可 import。**必须全绿再往下走。**

> 注意：`regress.mjs` 的 `touched` 清单是硬编码的。新增 `lib/redteam/agent-quota.js`、
> `task-stage.js` 之类文件要**同时**加进 `touched` 数组，否则不会校验语法与同步。

---

## 8. 施工顺序（建议）

| 序 | 任务 | 依赖 | 风险 | 估计 |
| --- | --- | --- | --- | --- |
| 1 | A 配额硬拒绝 | 无 | 中（`pre-execute` 顺序错会全堵死） | 小 |
| 2 | B 审计 + 守卫 | 无 | 低 | 小 |
| 3 | D 阶段判定表 | C 的表 | 低 | 小 |
| 4 | C `agent_task` 表 + 3 个工具 | 无 | 中（迁移必须幂等） | 大 |
| 5 | E 统一范围校验 | 无 | 中（`tunnel.entry` 误判会挡正常流程） | 中 |
| 6 | F 一致性核对 | C（要按会话统计） | 低 | 小 |

**先做 1、2**：这两项是「不补就会持续出事」的止血项。
**C 必须单独一次改动完成**（schema + store + 工具 + 提示词一起），半途的状态会让
「任务状态」与「回报」对不上，比没有更糟。

---

## 9. 必须避开的坑（汇总）

1. **`lib/tool-gate.js` 会把所有 `pre-execute` 结论压成 `allow`。**
   在它下游返回 deny 无效；红队配额必须注册在它**之后**（同为 `prepend:true`，更晚 apply）。
2. **`subagent/end` 的 `lastAssistantMessage` 是内容块数组**，不是字符串。
   已有 `textOfAssistantMessage`（`tools.js:101`）负责提取，**别重新写一个**。
3. **`parseAgentReport` 解析失败返回 null，不抛错**。任何依赖它的统计都会静默少算，
   不要假设「有回报就一定有 parsed」。
4. **`attentionQueue` 的 `latest` 是「每会话最新一条」**，加 `task_id` 之后不要顺手改成
   「每任务最新一条」—— 会话与任务不是一对一（一轮失败重派会有两个会话挂同一个任务）。
5. **`zstd` 会话日志是多帧拼接的**，用 `zlib.zstdDecompressSync` 整体解会报
   `ZSTD_error_prefix_unknown`。要按 magic `28 b5 2f fd` 切帧逐段解 —— 排查问题时用得上。
6. **`client.js` 的 drill 块内外各有一份 UI**。改文案/行为时两边都要动，然后 build 验证。
7. **`ctx.effect` 包住所有 `ctx.on`**：不留 disposer 会在热重载后叠加 N 份 handler
   （`tools.js:523` 的注释就是为此写的）。
8. **内存态（`slot-state.js` 的 `parked`、`reservations`）重启即失效**。
   任何要跨重启的事实都必须进 SQLite —— 这是任务 C 存在的理由。

---

## 10. 本次已完成（不要重做）

| 改动 | 位置 |
| --- | --- |
| `agent_report.acknowledged_at` + 迁移 | `lib/redteam/schema.js:387`、`:607`、`:732` |
| `acknowledgeAgentReports` | `lib/redteam/store-core.js:2008` |
| `attentionQueue` 跳过已处理 | `lib/redteam/store-core.js:2073` |
| `attentionAck` op | `lib/redteam/store-core.js:922` |
| `redteam_attention action=ack` | `lib/redteam/tools.js:1388` |
| `handleAttention` 只填不发、删 `submitAttentionPrompt` | `client.js:22995` |
| 按钮文案改为「填入主会话输入框」 | `client.js`、`lib/redteam/client.js` |
| 提示词加收口要求 | `client.js:22936` |

原因与实证见设计文档 §6。
