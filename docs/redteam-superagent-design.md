# 红队「演练台」与 superagent 的差距：设计文档

**性质：设计与差异分析，不含实现。** 本文只回答「现在是什么、缺什么、superagent 怎么做的、差距按什么顺序补」。
配套的落地细节（逐文件的函数签名、SQL、伪代码）在 [`redteam-superagent-dev.md`](redteam-superagent-dev.md)。

对照物：

| 名称 | 位置 | 版本 / 状态 |
| --- | --- | --- |
| 本插件 | `lib/redteam/`、`skills/redteam/`、`presets/redteam/` | `pi-purge` 1.1.75（`package.json` 仍写 `0.0.1`，不动） |
| 宿主 | DeepSeek Harness | 0.2.2-rc.3 |
| superagent 原型 | `.scratch/superagent-proto`（[Jueze-2019/dsh-redteam-mode] 之外的另一套） | README 自称 "Research prototype for reference only" |

阅读顺序：§1 先给结论表，§2 讲清两者根本不是一类东西，§3 逐个环节对照（这是本文主体），
§4 列「已实现 / 半实现 / 未实现」，§5 给补齐顺序与取舍，§6 记录这次暴露的缺陷作为设计依据。

---

## 1. 一页结论

| 环节 | superagent 的形态 | 本插件现状 | 差距等级 |
| --- | --- | --- | --- |
| 注册 | Source 插件把外部事件变成 Trigger，Engine 唯一写入口 | 无 Source 概念。任务由主会话用 `subagent` 工具直接 spawn，靠提示词里的 `redteamRole:` 行认角色 | **结构性缺失** |
| 调度 | `Passes` 每 2 秒一拍，`Engine.evaluateDue()` + `Effects` 队列；并发由 worker slot 管理 | 主会话自己决定派谁、什么时候派；并发靠 `redteam_agent_slot` 的**建议性**闸门 | **结构性缺失** |
| 会话传递 | `AgentDelivery` 按 `messageId(requestId)` 幂等投递，跨重启不重复 | 子会话 = 一次性 spawn，结束后不续；`resume` 能力未使用 | **结构性缺失** |
| 重新派任务 | Ticket 是持久实体，`retryTicket` 结束旧 Assignment、起新 Assignment，同会话同目录 | 只能重新 spawn 一个新子会话，上下文全丢 | **结构性缺失** |
| 确认任务状态 | `Ticket.attention`（结构化提问）+ `ticketStage()` 6 行判定表 | `agent_report` 表 + 尾行文本解析；确定性差一档 | **半实现** |
| 确定最终结论 | `report()` 里 `ready`/`dropped` 直接结束 Ticket，`followsDone` 处理 PR 收口 | 没有「结束」这个动作，回报只是记录 | **半实现** |
| 边界处理 | Mandate（授权凭据）+ Policy（版本化规则）+ 准入表；`tools/pre-execute` 之外还有引擎级拒绝 | 只有 `redteam_scope_check` / `redteam_batch` 两个入口查 CIDR，其余工具不查 | **半实现** |
| 结果验证 | 报告落库时校验引用（`askedBy` 必须是真人消息、`answers` 必须可答），`ready` 与 PR 状态对齐 | 有 `redteam_session_check`（真连）、`redteam_data_proof`（结构化条数），但**没有**「报告说拿到 = 库里真有」的强制校验 | **半实现** |

一句话：**superagent 是一台持久的状态机，本插件是一套好用的记账工具 + 提示词纪律。**
本插件的强项在「记什么」（资产/漏洞/凭据/隧道/得分/覆盖度，`lib/redteam/schema.js` 的 20 多张表）
和「怎么打」（40 个技能、5 个角色稿）；弱项在「谁在跑、跑到哪、卡在谁身上」这一层编排状态。

---

## 2. 两者不是同一类东西

### 2.1 superagent 解决的是「无人值守地长期接活」

它的 Source 是飞书和 GitHub —— 事件从外面自己来。所以它必须回答：
**事件来了算不算活？算谁的活？干完之后结论怎么回去？重启了怎么办？**

因此它的核心是一个**只由 Engine 写入**的状态机（`docs/007-architecture.md` 开头）：

```
Source → Trigger → Thread → Eval → Decision → Ticket(Mandate) → Assignment → Executor
```

Engine 是 Trigger / Thread / Decision / Ticket / Assignment 的**唯一写者**（同步、单事务），
外部副作用一律先入 `Effects` 队列表、提交后再执行（`src/app/effects.ts`）。
这条约束换来的是：任何时刻重启，都能从库里重建出「现在有几个活、各自等谁」。

### 2.2 本插件解决的是「有人盯着的一场演练」

靶标是用户当场给的，主会话就是指挥。所以它天然把编排交给模型：
`presets/redteam/agent.cordis.yml` 的 plan 提示词写死了「一次只派一个」「最多 3 个」「派活前后查名额」。

这套在**有人在看**的场景里工作得很好 —— 人就是调度器。它的失效点恰好是 superagent 的立足点：
**人不在的时候，没有人推进；而需要人决定的事，也没有一个可靠的地方把它挂住。**

### 2.3 因此「完全照搬」是错的

superagent 的一半复杂度来自 Source（飞书事件消费、GitHub 通知轮询、PR 生命周期、频道回复）。
红队没有这些东西：靶标不会自己发消息来。照搬 Source 层只会得到一堆没人调用的代码。

**该搬的是中间那三层：Ticket 状态机、Assignment 生命周期、Effects 持久队列。**
不该搬的是 Source / Channel / Policy 的版本化与准入表（红队没有多租户和多来源）。

---

## 3. 逐环节对照

下面每一节都按同一结构：**superagent 怎么做（带代码位置）→ 本插件现在怎么做（带代码位置）→ 差在哪 → 该借什么**。

### 3.1 注册（谁把「一件事」登记进来）

**superagent**

- Source 插件实现 `SourceContext` 接口，把外部消息翻译成 `Trigger`（不可变事件，带 actor、线程、频道地址）。
- `Intake.receive(trigger)`（`src/core/intake.ts:28`）做四件事：
  1. 按 `trigger.id` 去重，重复返回 `duplicate`；
  2. 按 `SourceScope` 过滤，被过滤的也落库并记 `filtered` 原因（**被丢掉的事件也留痕**）；
  3. 记 Thread 归属与 Correlation；
  4. 扇出到订阅了这些 Thread 的 Ticket，**并且**判断「有没有 Ticket 认领这条消息」，
     没人认领才入 Eval 队列（`if (!this.owners(trigger).length) this.queueForEval(trigger)`）。
- 注册的产物不是「一个任务」，而是「一条事实 + 它属于哪个 Thread」。任务（Ticket）是后面 Eval 决定出来的。

**本插件**

- 没有 Trigger。任务的起点是主会话调 `subagent` 工具（`presets/redteam/agent.cordis.yml:333`，
  `provider: spawn`、`backgroundMode: continuable`、`maxDepth: 1`）。
- 「注册」实际发生在**子会话自己身上**：任务描述第一行写 `redteamRole: <code>`，
  宿主在 `agent/inbox/claimed` 时被 `lib/redteam/role-section.js` 的 `ROLE_TAG` 正则捕获，
  记进模块级 `roleBySession`，组装系统提示词时把 `engagements/<靶标>/agents/<code>.md` 插进去。
- 也就是说：**角色是提示词层的约定，不是数据层的实体**。没有行、写错 code、或子会话换了角色，全部静默失效
  （`noteClaimedMessage` 找不到就 `return`）。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 去重 | Trigger id 幂等，重复注册只算一次 | 无。同一个任务重复 spawn 就是两个真子会话 |
| 被拒的事件 | 落库 + 记原因 | 无概念 |
| 归属 | Thread / Ticket 有明确外键 | 只有 `parent_session` 一个软字段 |
| 角色 | 是 Ticket 的属性，写死在引擎里 | 是提示词里的正则，靠模型自觉 |

**该借什么**

借「注册 = 落一条带 id 的事实，且重复注册幂等」这一条，**不借 Source 层**。
具体到红队：`redteam_agent_slot action=acquire` 应该真的产出一个可查询的 Assignment 行
（含 assignmentId、角色、任务摘要、起始时间），而不是往内存 `reservations` Map 里塞一个
`label#timestamp`（`lib/redteam/tools.js:335` `addReservation`）。内存态一重启就没了。

---

### 3.2 调度（谁决定「下一个派谁、什么时候派」）

**superagent**

- `Passes`（`src/app/passes.ts:31`）：`setInterval(2000)` 一拍，每拍 `effects.kick()` 然后 `engine.evaluateDue()`。
  同一时刻只跑一拍，并发调用会被合并成「再跑一次」（`pump()` 的 `pumpAgain` 逻辑）。
  一拍失败会写进 health，下一拍成功再清掉。
- 调度是**数据驱动的**：`evaluateDue()` 遍历所有有排队 Trigger 的 Thread，每个 Thread 起一个 Eval；
  Eval 有 deadline，超时重新入队两次、第三次记 `unavailable`（`src/core/evals.ts` 的 `expire`，
  `REQUEUES = 2`）。
- 并发由 worker slot 管理（`docs/003-execution.md` §Concurrency）：Ticket 从 launch 开始占一个 slot，
  另留**一个额外 slot 专供人的消息**，保证人不会被自动任务挤出去。
- 暂停（`pause processing`）只停「派活 / 新 Eval / 投递 / 回复」，已经跑起来的 turn 不打断。

**本插件**

- 调度完全在提示词里。`lib/redteam/store-core.js:540` 附近的 plan 提示词写着：
  「默认一个一个派、按顺序推进」「每次只拉起一个智能体，跑完再派下一个」「同一个靶标同时最多 3 个」。
- 代码侧只有一个**建议性**闸门 `redteam_agent_slot`（`lib/redteam/tools.js:902`）：
  - `liveRunningChildren()`（`:303`）读 `ctx.get('subagents').listChildren(root)`，数 `activity === 'running'` 的子会话；
  - `maxAgentsNow()`（`:138`）读 `settings.json` → `REDTEAM_MAX_AGENTS` → 默认 3；
  - `acquire` 满了直接返回 `ok:false`，提示词要求「不要重试硬塞」。
- 关键事实：**没有任何 `tools/pre-execute` 拦截**。子会话照样能被 spawn 出去，闸门只是让模型自己不派。
  模型不听话（或者上下文被冲掉）时，3 个上限形同虚设。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 拍子 | 有，2 秒一拍，可观测 | 无。只能在子会话结束时被动触发一次 |
| 上限 | 硬约束，引擎层拒绝 | 软建议，模型自觉 |
| 人的优先级 | 单独留一个 slot | 无概念，人的消息和自动任务抢同一个额度 |
| 超时 | Eval 有 deadline，超时重排 | 子会话可以无限期挂着 |
| 暂停 | 一等公民，有状态 | 无 |

**该借什么**

先借最小的一件：**把「上限」从提示词搬到代码里**。宿主已经有 `tools/pre-execute` waterfall
（本插件已经在用，见 `lib/tool-gate.js` 的注释），在 `subagent` 工具调用前查一次 `liveRunningChildren`
就能硬拒。注意 `lib/tool-gate.js` 的 `coerceGate` 会把所有结论压成 `allow` —— 这是**故意的**
（避免关掉下游副作用），所以红队配额检查必须放在**它之前**的另一层，或者改成
「在同一个 handler 里先判配额、再 next()」。这一点在开发文档里是第一个要处理的坑。

不借 `Passes` 定时器：红队没有「事件自己来」的场景，加一个空转的 2 秒拍只会白烧 CPU。

---

### 3.3 会话传递（子会话之间、主会话与子会话之间怎么传消息）

**superagent**

- `AgentDelivery`（`src/app/delivery.ts`）是唯一的投递通道，核心是**幂等**：
  ```ts
  export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
  ```
  同一个 `requestId` 重试多少次，Session 里都只出现一条。它同时扫三处来判断「见过没有」：
  本进程见过的 id、持久化历史（`sessionPersistence.open` 逐批读 `user/message`）、
  以及 inbox 里还挂着没被消费的。
- 消息带自己的 source：`{ kind: 'dsh-superagent', form: 'relay' }`。
  **插件发的消息永远不会被误认成真人写的** —— 这一点在 `docs/001-domain.md` 里是明确的规则。
- 三种投递模式：`queue`（下一轮）、`steer`（下一步）、`{ inject }`（注入历史但不唤醒）。

**本插件**

- 主 → 子：spawn 时的一次性 prompt，之后**没有通道**。要追加信息只能 `send_message`（宿主工具）。
- 子 → 主：子会话结束时宿主发 `subagent/end`，`lib/redteam/tools.js:527` 的 handler 读
  `info.lastAssistantMessage`（内容块数组），解析出 `redteamReport: {...}` 落库。
  **这是单向的、只在结束时发生一次的。**
- 主会话自己往自己的会话里塞消息，走的是渲染层的 `input.setDraft` + `input.submit('queue')`
  （`client.js:22972` 附近）。这类消息带 `source.kind: "user"` 和 `rpcId` —— **在库里与真人输入无法区分**。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 幂等 | 按 requestId 强幂等，跨重启 | 无 |
| 身份 | `kind: 'dsh-superagent'`，可区分 | 插件合成的消息伪装成 `kind: 'user'` |
| 通道 | 双向（Input 进 worker、Report 回主） | 单向（只在结束时回一次） |
| 唤醒 | 能唤醒 idle 的 worker | 不能，只能新 spawn |

**该借什么**

借**「插件消息必须带自己的 identity」**这一条，这是最便宜、收益最大的一条。
本插件已经有正确范例：`lib/continue-retry.js:128` 的 `makeContinueMessage` 用
`source: { kind: "pi-purge", form: "notice" }`，并且 `hasFreshHumanTurn`（`:246`）
明确按 `source.kind` 过滤掉 `"plugin"` / `"pi-purge"`。
**但唤醒「去处理」的那条消息没有走这条路** —— 它走渲染层 submit，因此变成了「真人说的话」。
这是 §6 记录的缺陷的直接成因之一。

---

### 3.4 重新派任务（失败了怎么接着干）

**superagent**

- Ticket 是持久的，Assignment 是「某一轮执行」。`retryTicket`（`docs/007` 的 Engine 表）：
  结束当前 Assignment，在**同一个 Executor Session、同一个目录、同一个分支、同一个 PR** 上起新 Assignment。
- 重启后的恢复路径也走这里：`Assignments.interrupted()`（`src/core/assignments.ts:83`）判断
  上一轮是不是「已 settled」（`waiting|ready|blocked|failed` 且之后没有新 Input），
  settled 就保留会话只补投 Input，没 settled 就 `restart` 并塞一段 `RECOVERY_NOTE`：
  「先查 worktree、git 历史、GitHub 状态，不要重复已经做过的外部动作」。
- 瞬时失败（`transient()`，`src/executor/dsh.ts:41`：408/429/5xx/连接被拒/超时）有专门的重试：
  3 次、递增退避，launch 重跑或让 worker「继续」；prepare 命令失败**不重试**（避免把半成品目录当成品）。

**本插件**

- 重新派 = 重新 spawn 一个新子会话。老子会话的上下文、已经排除的路径、已经拿到的中间结论全部丢失。
- `redteam_agent_slot` 有 `status=blocked|waiting` 时把自己 `parkAgent`（`lib/redteam/slot-state.js`），
  `subagent/end` 里也会兜底 park —— 意图是对的（「别占着名额空等」），但 park 状态是
  **模块级 `Map`，纯内存**，进程重启即归零；而且它只影响「算不算名额」，不影响「这条活现在什么状态」。
- `lib/continue-retry.js` 有 `autoRetry: true, retryMax: 3`，但那是**主会话**的续跑重试，
  与子会话无关。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 重派的粒度 | 同一 Ticket 换 Assignment | 换一个全新子会话 |
| 上下文 | 保留（同 Session） | 丢失 |
| 重启恢复 | 有明确路径 + 恢复提示词 | 无。park 状态内存态，队列全是历史残留 |
| 瞬时失败 | 分类重试 | 无（子会话崩了就是崩了） |

**该借什么**

借「**活是持久的，执行是轮次的**」这个模型，这是整套设计里最值钱的一条。
落到红队不需要 Assignment 表那么重：一个 `agent_task` 表（靶标、角色、任务摘要、
状态、当前 assignment、上一轮结论）就够。但**关键是要有 id**：有了 id 才能
「重新派给同一个任务」，模型才有地方写「这条我试过了，换成另一条路」。

---

### 3.5 确认任务状态（怎么知道「现在等到哪了」）

**superagent**

两层：

1. **结构化的事实**：`Ticket.attention` 是一个对象 `{ id, question, triggerId? }`，
   由 `orchestrator_report` 的 `human_action` 字段产生（`src/app/tools/executor.ts:75`）。
   报告还能带 `question_for_trigger_id`（这个问题是哪条真人消息引出的，决定回在哪）和
   `reply_to_trigger_id`（这份报告回答的是哪个问题）。**全部是枚举和 id，不是自由文本。**
2. **确定性的判定表**：`src/core/stage.ts` 的 `ticketStage()`，从上往下第一个匹配的赢：

   | 顺序 | 条件 | 阶段 |
   | --- | --- | --- |
   | 1 | `ticket.ended` | `ended` |
   | 2 | `ticket.delivery`（投递失败） | `person/delivery` |
   | 3 | `ticket.attention`（有挂起的问题） | `person/answer` |
   | 4 | 最新报告 `ready` | `person/review` |
   | 5 | 最新报告 `blocked`/`failed` 且 `waitsForPerson` | `person/blocked` / `person/failed` |
   | 6 | 没有 Assignment 或 pending | `working/queued` |
   | 7 | 报告 `waiting` 或 Assignment 已结束 | `idle` |
   | 8 | 其余 | `working` |

   注意 `person/*` 的共同含义是「**没有人的输入就动不了**」，而 `idle` 是「这一轮干完了，等新事件」。

**本插件**

- 子会话结束时写一行 `agent_report`（`lib/redteam/schema.js:373`；写入 `store-core.js:1970`），
  字段 `status = progress|waiting|ready|blocked|failed|dropped` + `blocked_reason` + `needs[]`。
- 解析靠 `parseAgentReport`（`store-core.js:1894`）：在自由文本里找 `redteamReport: {...}`，
  带伪 JSON 兜底。**模型少写一行、写错状态词、或者把 JSON 写坏，就整条丢失**（`parsed === null` 时什么都不写）。
- `attentionQueue`（`store-core.js:2058`）取**每会话最新一条**，按 `waiting > ready > blocked > failed > progress` 排序。
- 界面侧：`client.js:21918` 起每 8 秒拉一次 `/redteam/api {op:'attention'}`，
  `AttentionToast`（`:23050`）渲染成右下角胶囊，面板 `OverviewTab`（`lib/redteam/client.js:10348`）渲染成第一屏。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 状态来源 | 结构字段（枚举 + id） | 自由文本里的约定行 |
| 判定 | 有确定性的表，代码里可测 | 只有排序，没有「这条是否还能推进」的判定 |
| 生命周期 | Ticket 有 ended，状态收敛 | **没有结束语义**，最新一条永生 |
| 人的问题 | 是对象，有 id，可撤回 | 是待办列表里的一个元素，没有 id |

**该借什么**

借两样：

1. **判定表**。`ticketStage` 那张 6 行表几乎可以原样搬：把 `agent_report` 的 status 映射成
   stage 已经有雏形（`attentionQueue` 里的 `stage` 字段），缺的是「`ended` / `idle` / `queued`」
   这几种非 `person` 的状态，以及「什么条件算结束」。
2. **结束语义**。见 §3.6。

---

### 3.6 确定最终结论（什么时候算「这件事完了」）

**superagent**

- `Assignments.report()`（`src/core/assignments.ts:96`）里，报告落库的同时就决定是否结束 Ticket：
  ```ts
  const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped'
    : report.state === 'ready' ? ready : undefined
  if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
  ```
  `ready` 的语义是「干完了，等人验收」；如果不跟随任何 Thread，直接 `completed` 结束；
  如果跟随 PR，要等 `followsDone`（所有它开的 PR 都关掉）才结束。
- `dropped` 是「没活可干」：结束但不发消息，除非匹配的规则要求发。
- 结束不是删数据：`ended` 记录时间、谁、为什么、什么结局，Subscriptions 保留，
  之后真人在这个 Thread 上再说话还能 resume（除非是被真人 `stopTicket` 停的）。

**本插件**

- **没有「结束」这个动作。** `agent_report` 只有 `dropped` 这一个状态被 `attentionQueue` 跳过
  （`if (r.status === 'dropped') continue`），其余全部长期驻留。
- 「这一轮打完了」这个判断写在返回值的 `note` 字符串里（`store-core.js` 的 `attentionQueue`：
  `items.length === 0 && pendingCoverage === 0` → 「没有人等、也没有队列缺口：这一轮打完了」）。
  **是一句给人看的话，不是给代码用的状态。**
- 覆盖度队列（`asset_coverage` / `host_coverage`）承担了「还有什么没做」，
  但它回答的是「还缺什么动作」，不是「这个任务结束了没有」。

**差在哪**

- superagent 的结束是**引擎里的一次状态迁移**，会连锁触发通知、释放 slot、允许 resume。
- 本插件的「结束」是**没有状态**：只要没人再写新报告，队列就永远显示旧的那几条。
  这直接导致 §6 的缺陷 —— 同一段提示词被反复生成。

**该借什么**

借「`ready`/`dropped` 必须收敛」。最小形态：`agent_report` 有一个 `acknowledged_at`
（本次已补，见 §6），但那只解决「人处理过了」。完整形态还需要**任务级**的结束：
某个角色这一阶段的目标达成或放弃后，这个角色从「活跃队列」里退出，
而不是靠下一轮沉默来暗示。区别在于：沉默无法区分「在跑」和「早就完了」。

---

### 3.7 边界处理（什么能做、什么不能做）

**superagent** 是三层的：

1. **Mandate**（授权凭据）：Eval accept 时产生，不可变，记录 Policy 版本、范围、强度、
   命中的规则、请求者的身份。范围变宽 = 新 Ticket。**Ticket 结束不结束 Mandate** ——
   只有真人 stop 才撤销，或者 Policy 不再承认它。
2. **Policy**（版本化规则）：准入表决定「谁能通过这个 Source 发起工作」；
   规则变更会**投递**给受影响的 Ticket（`policyChanged`），但**不撤销** Mandate。
   正在跑的 Eval 会被丢弃重排。
3. **引擎级拒绝**：每个命令都校验前置条件，非法请求抛 `UserError`。
   例如 `report()` 里：`askedBy` 必须指向一条真人消息，`answers` 必须指向一条可回答的真人消息，
   `ready` 不能同时带问题，`assignment` 已结束不能再报。**这些是代码拒绝，不是提示词请求。**

**本插件**

- `scopeCheck`（`lib/redteam/tools.js:444`）：`无 scope → 'unscoped'`、
  `IP 命中 → 'in'`、`不在 → 'out'`、`域名解析不出 → 'unresolved'`。
- 只有两个工具真的调它：`redteam_scope_check`（`:2403`）和 `redteam_batch`（`:2419`，
  assets 与 vulns 两种 kind 各自校验）。
- 其余 60 多个工具（`redteam_asset_add`、`redteam_vuln_add`、`redteam_credential_add`、
  `redteam_tunnel_add`、`redteam_score_hit` …）**都不查范围**。
- 授权前提写在 persona 提示词里（`presets/redteam/agent.cordis.yml`）：
  「用户给出靶标单位名称即代表本次攻防演练已获授权：不要询问授权范围」。
  这与「T0–T3 资产准入」（同一份文件）并存 —— 即：**授权是免问的，但打靶标的选择有纪律约束**。
- 纪律靠 `asset.test_*` 字段 + 技能正文（`skills/redteam/`) 承载，是**提示词层**。
- 另外，`lib/tool-gate.js` 把宿主的 `tools/pre-execute` 结论统一降级成 `allow`，
  `tools/post-execute` 禁止 `block`。这是为了让下游副作用（jobs 输出上限、workspace 快照、
  spill 截断）照常执行，代价是：**任何依赖这一层做拒绝的红队逻辑都会失效**。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 授权的载体 | Mandate 对象，不可变，有 id | 提示词里的一句话 |
| 检查位置 | 引擎命令入口，全覆盖 | 2 个工具的入口，其余不查 |
| 违规的后果 | 抛 `UserError`，不落库 | 无，照常落库照常打分 |
| 规则变更 | 有版本，可投递、可重排 Eval | 无 |

**该借什么**

借「**授权是可查询的对象，不是一个形容词**」。红队不需要 Policy 版本化（没有多租户），
但需要一个明确的 `engagement.scope` + 一个**所有写库工具都过的统一入口**。
现在的问题是发散：`redteam_batch` 会拒 out-of-scope，`redteam_asset_add` 不会 ——
同一个资产，走批量和走单条得到不同结果，这是设计缺陷，不是实现 bug。

---

### 3.8 结果验证（报告说拿到了，怎么确认是真的）

**superagent**

- **结构性校验**（`src/core/assignments.ts:96` 起）：报告里的 `askedBy` 必须是一条真人消息且能到达这个
  Ticket（`person(id, true)`），`answers` 必须是可回答的（`person(id, false)`），
  否则抛 `notAsker` / `notAnswerable`。
- **状态校验**：`ready` 只在真的做完时允许结束；跟 PR 的 Ticket 要看 PR 是否真关了。
- **投递校验**：`inputsDelivered` / `inputsRead` 是分开的两个事实 ——
  「送到了」和「读到了」不是一回事，只有后者才动 `readAt`。
- **重试的持久性**：`RECOVERY_NOTE` 要求重启后的 Executor 先看目录、git 历史、GitHub，
  再决定要不要重复外部动作。

**本插件**（这部分其实做得不差，但要认清它验证的是什么）

- `redteam_session_check`（`lib/redteam/tools.js:1782`）：**真发起** HTTP / SOCKS5 CONNECT
  去连 WebShell 和隧道，把在线/离线回写库。1.1.75 里 `socks5Probe`（`:454`）是完整的三段握手。
  这是真验证，不是读字段。
- `redteam_data_proof`（`:2503`）：结构化记录字段 / 条数 / 样本 / 来源，
  `row_count >= 10000` 自动标 `meets_threshold` —— 把「P1 一万条」从形容词变成可比较的数字。
- `redteam_score_report`（`:2151`）：只收录真拿到分的成果，每条尽量附可粘贴复现的原始请求。
- 覆盖度表（`asset_coverage` / `host_coverage`）把「打完了没有」拆成 5 项和 7 项，
  `redteam_asset_next` / `redteam_next_action` 从里面读缺口。

**差在哪**

| 维度 | superagent | 本插件 |
| --- | --- | --- |
| 报告校验 | 引擎级拒绝非法引用 | 无（`redteamReport` 解析成功就落库） |
| 「拿到」的定义 | 有明确的状态迁移 | 靠工具写得对不对（漏洞 status=confirmed/exploited） |
| 连接性 | 不适用 | 已验证（真发包） |
| 数据量 | 不适用 | 已验证（结构化条数） |
| 报告↔库的一致性 | 有 | **没有强制校验**：报告说「拿到 12 台服务器」，库里 `score_hit` 是不是 12 条，没人核对 |

**该借什么**

借「**报告必须能被库里的行验证**」。红队已经有全部素材（`score_hit`、`vuln`、`credential`、
`webshell`、`tunnel`、`host_finding`），缺的是一个**核对动作**：
把 `agent_report.summary` 里声称的数字，和库里该会话（或该靶标本轮）实际写入的行数对一遍，
不一致就标出来。这比 superagent 的引用校验更适合红队，因为红队的「成果」天然是计数。

---

## 4. 现状盘点：已实现 / 半实现 / 未实现

### 4.1 已实现（不用担心）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 靶标工作区 + SQLite 事实库 | `lib/redteam/store-core.js`、`schema.js` | 20+ 表，含资产/端口/服务/漏洞/凭据/WebShell/隧道/攻击步骤/得分点/命中/覆盖度/回报 |
| 统一 op 分发 | `store-core.js` 的 `dispatch` | 面板、CLI、工具共用一套词汇 |
| 角色稿注入 | `lib/redteam/role-section.js` | `redteamRole:` 正则 + 按靶标读 `agents/<code>.md` |
| 结构化回报 | `store-core.js:1894 / :1970` | 自由文本解析 + 落库，每会话保留 20 条 |
| 等待队列 | `store-core.js:2058` `attentionQueue` | 排序 + `needs` 汇总 + 覆盖度缺口 |
| 等待队列收口 | `store-core.js:2008` `acknowledgeAgentReports` | **本次新增**，见 §6 |
| 并发名额（建议性） | `tools.js:902` + `slot-state.js` | 真实读注册表，parked 不占名额 |
| 覆盖度驱动下一步 | `store-core.js:1738 / :1854` | `hostNextActions` / `assetNextActions` |
| 真实连通性验证 | `tools.js:1782 / :454` | HTTP + SOCKS5 真探测 |
| 结构化数据证明 | `tools.js:2503` | 字段/条数/样本，1 万条门槛 |
| 范围校验（部分） | `tools.js:444` | 仅 2 个入口调用 |
| 得分口径统一 | `lib/redteam/score-rules.js` | 服务封顶、按服务去重、G5/G6 倍率 |
| 技能库 | `skills/redteam/` 40 个 | 与本问题无关，但它是「怎么打」的资产 |

### 4.2 半实现（有骨架，缺关键一半）

| 能力 | 有的部分 | 缺的部分 |
| --- | --- | --- |
| 任务状态 | `agent_report.status` 枚举 + stage 映射 | 没有 `ended` / `idle` / `queued`；没有「结束」语义 |
| 调度 | 名额查询 + 提示词纪律 | 没有代码级拒绝；没有拍子；没有超时 |
| 边界 | `scopeCheck` + 2 个入口 | 其余写库工具不校验；授权不是对象 |
| 验证 | 连通性、数据量、得分报告 | 报告与库行数的一致性核对 |
| 会话传递 | `subagent/end` 单向回报 | 没有 Input 回传通道；没有幂等；没有唤醒 |
| 重派 | 可以重新 spawn | 上下文丢失；没有任务 id；重启后无恢复路径 |

### 4.3 未实现（明确没有）

| 能力 | 说明 | 是否需要 |
| --- | --- | --- |
| Trigger / Source 层 | 红队没有外部事件源 | **不需要** |
| Channel / 回复路由 | 没有飞书/GitHub 回帖需求 | **不需要** |
| Policy 版本化 | 单用户单靶标 | **不需要** |
| Mandate 对象 | 授权是一句话 | 需要，但可以极简（一个 scope + 一个不可变的 open 记录） |
| Assignment 生命周期 | 子会话 = 一次性 | **需要**，是 §3.4 的核心 |
| Effects 持久队列 | 所有副作用都在调用现场同步做 | 部分需要（投递与重派） |
| Eval / 判定层 | 没有独立判定 | 部分需要（判定表可以直接搬） |

---

## 5. 补齐顺序与取舍

**不要一次全搬。** 按「不补就会持续出事」排序：

### 第一阶段：止血（这次已经做了一半）

1. ✅ 回报能收口（`acknowledged_at` + `redteam_attention action=ack` + `attentionAck` op）。
2. ✅ 「去处理」只填不发（删掉 `submitAttentionPrompt`，按钮改叫「填入主会话输入框」）。
3. ⬜ **配额变成硬约束**：在 `tools/pre-execute` 层（注意 `lib/tool-gate.js` 的降级逻辑）
   拒绝超额 spawn。这是提示词纪律的唯一兜底。
4. ⬜ **插件消息带自己的 identity**：任何由插件塞进主会话的文字都不能再走渲染层
   `input.submit`，否则 `kind: "user"` 会让它永远无法与真人输入区分。

### 第二阶段：让状态可查（对应 §3.5 / §3.6）

5. ⬜ `agent_task` 表：一个任务一行，有 id、角色、状态、当前 assignment、上一轮结论。
   `redteam_agent_slot acquire` 返回 assignment id，而不是内存里的 `label#timestamp`。
6. ⬜ 搬 `ticketStage` 的判定表，补齐 `ended` / `idle` / `queued`。
7. ⬜ 定义「结束」：`ready` / `dropped` 收敛任务，不再永生。

### 第三阶段：让重派有意义（对应 §3.3 / §3.4）

8. ⬜ 任务持久化后，重派 = 新 assignment 指向同一个任务 id，任务摘要带上「已试过什么」。
9. ⬜ 幂等投递：给每条插件消息一个确定性的 id，避免重复。
10. ⬜ 重启恢复：从 `agent_task` 重建「哪些任务在跑 / 哪些在等人」。

### 第四阶段：把边界收成一处（对应 §3.7）

11. ⬜ 所有写库工具过同一个 `assertInScope`，而不是散落在 2 个入口。
12. ⬜ 报告与库的一致性核对（对应 §3.8 的差距）。

**明确不做的**：Source / Channel / Policy 版本化 / PR 生命周期 / Eval 的 deadline 重排。
理由：红队没有多来源、多租户、外部 PR。搬它们只会制造没人调用的代码。

---

## 6. 本次缺陷作为设计依据

### 6.1 现象

一段固定文字（`演练台有 N 个智能体在等人…`）会定期出现在主会话对话里，内容一字不变。

### 6.2 定位（有实证，不是推测）

会话日志 `<DSH_HOME>/sessions/<WORKSPACE>/<SESSION>/session.v4.jsonl.zstd`
（多帧拼接的 zstd，需按 `28 b5 2f fd` magic 逐帧解压）里：

- 该文本共 8 处记录，其中 4 处 `agent/inbox/spliced`、4 处 `user/message`；
- 4 处里有 **4 个不同的 `rpcId`**；
- source 全部是 `{ kind: "user", rpcId: ..., clientTimeZone: "Asia/Shanghai" }`。

`kind: "user"` + `rpcId` 意味着：这是渲染层通过宿主 RPC 真实提交的，**不是插件写的**。
插件写的消息会带 `kind: "plugin"` 或 `kind: "pi-purge"`（正确写法见
`lib/continue-retry.js:128`）。

### 6.3 成因链（两条缺陷叠加）

1. **`attentionQueue` 没有收口语义**（`store-core.js:2058` 旧版）：
   每个会话取最新一条回报，`waiting`/`ready`/`blocked`/`failed` 永久驻留。
   演示数据 `demo-vuln-scan` / `demo-exploit` / `demo-internal` 一直躺在靶标 `TARGET_REMOVED` 里。
2. **`handleAttention` 会真的发送**（`client.js` 旧版 `handleAttention`）：
   文档注释写着「只填不自动发送」，代码却调了 `submitAttentionPrompt` → `input.submit('queue')`。
   于是每次触发都：生成**逐字节相同**的文本 → 填进输入框 → 提交成一条真人消息。

两者相乘 = 「同一段话被真发了 N 次」。**只修任何一条都不够**：
只修 1，按钮还是会把同一段发出去；只修 2，队列还是永远非空，胶囊永远提示「N 个人在等」。

### 6.4 已做的修复

| 改动 | 文件 | 作用 |
| --- | --- | --- |
| `agent_report.acknowledged_at` 列 + 迁移 | `lib/redteam/schema.js:387 / :607 / :732` | 回报可被标记处理过 |
| `acknowledgeAgentReports(id, {session_id\|ids\|all})` | `lib/redteam/store-core.js:2008` | 只作用于该会话最新一条，幂等 |
| `attentionQueue` 跳过已处理 | `lib/redteam/store-core.js:2073` | 队列真的会变空 |
| `attentionAck` op | `lib/redteam/store-core.js:922` | 面板/CLI/工具共用 |
| `redteam_attention action=ack` | `lib/redteam/tools.js:1388` | 主会话处理完能收口 |
| 删掉 `submitAttentionPrompt`，`handleAttention` 只填不发 | `client.js:22972` | 不再替人做决定 |
| 按钮文案「派给主会话处理」→「填入主会话输入框」 | `client.js`、`lib/redteam/client.js` | 文案与行为一致 |
| 提示词加「每条处理完用 action=ack 摘掉」 | `client.js:22936` | 让收口成为流程的一部分 |

**实证**（真机库 `<DSH_HOME>/redteam`，靶标 `TARGET_REMOVED`）：

```
[before]  total: 3, awaiting: 3
[ack 1]   {"acknowledged":1}          → total 2, 剩 demo-exploit / demo-internal
[ack all] {"acknowledged":2}          → total 0, gaps 1
[idempotent] {"acknowledged":0}       → 重复 ack 无副作用
新写一条 waiting 回报 → total 1，回到队列（证明「新事件仍会进来」）
列结构实测含 acknowledged_at
```

### 6.5 设计教训（写进后续实现的约束）

1. **写给用户看的话，不能由代码替用户发出去。** 需要人决定的地方，代码只负责整理，
   发送键必须是人按的。
2. **插件合成的内容必须带自己的 identity。** 走渲染层 submit 会让它变成 `kind: "user"`，
   从此无法与真人输入区分 —— 而「区分真人输入与自动输入」是很多能力的前提
   （见 `lib/continue-retry.js` 的 `hasFreshHumanTurn`）。
3. **没有收口动作的队列等于常量。** 任何「等人处理」的列表都必须有「处理完了」的迁移，
   否则它既不能驱动流程，也没有信息量。
4. **文档注释和代码必须同时改。** 本次缺陷的第一现场就是一段写着「只填不自动发送」、
   下一行却在 submit 的注释。

---

## 7. 术语对照

| superagent | 中文 | 本插件对应物 | 是否等价 |
| --- | --- | --- | --- |
| Source | 事件源 | 无 | 否 |
| Trigger | 事件 | 一次 spawn 的任务描述 | 否（无法去重、无法归属） |
| Thread | 线程 | 靶标（engagement）+ 会话绑定 | 部分 |
| Eval | 判定 | 主会话自己判断 | 否（无 deadline、无重排） |
| Ticket | 工单 | **无**（最关键的缺口） | 否 |
| Mandate | 授权凭据 | 提示词里的一句话 + `engagement.scope` | 否 |
| Assignment | 执行轮次 | 一次 `subagent` spawn | 部分（无 id、无续期） |
| Report | 报告 | `agent_report` 一行 | 部分（能落库，不能收口→现已补齐） |
| Attention | 挂起的问题 | `agent_report.status='waiting'` + `needs[]` | 部分（无 id、不可撤回） |
| Effects | 副作用队列 | 无（都在调用现场同步做） | 否 |
| Passes | 调度拍子 | 无 | 否 |
