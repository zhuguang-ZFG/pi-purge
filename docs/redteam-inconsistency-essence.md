# 红队不一致：本质说明

对照双方：

- 上游：`dsh-redteam-mode` tag **v0.14.3**（`COMMIT_REMOVED`），实现以 `packages/redteam-bundle/` 为准。
- 插件：`pi-purge` **1.1.75**，红队在 `lib/redteam/`、`presets/redteam/`、`skills/redteam/`。浏览器真正加载的是根目录 `client.js` 嵌入块。

这份文档只写**还不一致**的部分。已经对齐的（态势页、五分区、会话跟随、模板化报告骨架、标题栏、全面浏览）不展开。  
搬入时拍过板的决策见 `docs/redteam-port-plan-1-3-4-5-6.md`；这里写的是那些决策落在运行时上的**真实后果**。

---

## 0. 先看三层，再看症状

同一套「红队模式」其实有三层。不一致几乎都出在后两层。

| 层 | 是什么 | 谁强制 | 0.14.3 对齐程度 |
| --- | --- | --- | --- |
| 面板 | 人看的分区、态势、报告排版 | 没有强制力 | 高 |
| 闸门 | 工具能不能看见、查询参数认不认、分怎么乘、名额怎么放 | 平台代码，模型绕不过 | 低 |
| 人设 | 指挥/执行角色被要求怎么打 | 模型遵守程度不稳 | 低 |

面板像 0.14.3，不代表指挥和执行角色按 0.14.3 的打法走。

四条本质轴（后面每一节都挂在其中一条上）：

1. **职责边界靠什么执行**：上游用预设把工具裁掉；插件用提示词请角色别越界。
2. **默认打法写了三份，查询能力还不配套**：源码默认稿、指挥人设、已有靶标的 `agents/*.md` 是三份副本；上游那套「分批评估」在插件查询 API 上根本调不出来。
3. **同一条事实怎么算、怎么展示**：凭据明文、IPv6 倍率、预留释放、`.env` 解析。
4. **包和宿主跟谁走**：独立插件 vs 嵌在清洗面板；技能随包范围；更新通道。

---

## 1. 职责边界：硬隔离 vs 软隔离

### 本质

DSH 0.2.1 之后，子会话的人设和工具集不能再写在 `tool-subagent` 的 `persona` / `toolFilter` 上（写了会在 `apply()` 抛错）。  
上游的解法是：**另挂一套执行角色预设**，子会话进另一份 Agent Preset。  
插件的解法是：**子会话仍留在主预设里**，靠任务第一行 `redteamRole:` 把角色稿塞进系统提示词。

这不是「少了几个 yml 文件」。这是「越界靠平台拒绝」还是「越界靠模型自觉」。

### 上游

主预设 `presets/redteam/agent.cordis.yml`：

- `tool-subagent.agentPreset` 默认 `redteam-worker`
- 允许的预设名单：`redteam-worker`、`redteam-worker-recon` / `assess` / `vuln-scan` / `exploit` / `internal`
- 指挥人设要求派活时传 `agent_preset=redteam-worker-<角色>`

每个 `worker-*.cordis.yml`：

- 自己的 persona：你是叶子，本预设没有委派工具
- `redteam-tools` 带 `config.profile: recon|assess|…`
- **不挂** `subagent` / `subagent_fork` / `workflow` / `ralph`

`lib/tools.js` 的 `PROFILE_EXCLUDES` 按 profile 从注册表里拿掉越界写工具。漏配的后果是「多看见一个工具」，不是「关键工具被裁掉」。典型裁法：

| 角色 | 看不见的（节选） |
| --- | --- |
| recon | 评估、记漏洞、记凭据/马/隧道、记分、出报告、改提示词、知识库写、删截图 |
| assess | 记漏洞、记入口、记分、出报告、改提示词 |
| vuln-scan | 评估、记马/隧道、改得分点、出报告 |
| exploit | 评估、改得分点、出报告 |
| internal | 改得分点、出报告 |

recon 调用 `redteam_score_hit`：**工具不存在**，调了就是失败。

### 插件

只有 `presets/redteam/agent.cordis.yml`。没有 `worker-*.cordis.yml`。

`lib/redteam/tools.js` 的 `apply(ctx)` **不读 profile**，一次注册全部红队工具。

子会话路径：

1. 指挥在 `subagent` 的 `prompt` 第一行写 `redteamRole: recon`（只能是五个 code）
2. `lib/redteam/role-section.js` 在子会话领到用户消息时记下角色
3. `lib/index.js` 组装系统提示词时，把 `$DSH_HOME/redteam/engagements/<当前靶标>/agents/<code>.md` 插进去
4. 没有这一行就不猜角色，子会话按主预设工具集跑

子会话和指挥看见同一套工具，包括委派工具。叶子约束只写在稿子里。

`modelSelectionSettings`：插件主预设锁 `false`，`lib/redteam/index.js` 还会把用户副本里的 `true` 改回 `false`。上游 worker 侧可以开模型选择。

### 功能区别

| 行为 | 上游 | 插件 |
| --- | --- | --- |
| 派活参数 | `agent_preset` | `redteamRole:` 第一行 |
| recon 记分 / 建隧道 | 工具不在，失败 | 工具在，只靠稿子劝阻 |
| 执行角色再 `subagent` | 工具不在 | 工具在 |
| 角色稿怎么进子会话 | 指挥用 `redteam_role_prompt` 取出，抄进任务描述 | 平台按第一行注入 `agents/<code>.md`，稿子要求**不要**把全文抄进任务 |
| 换模型 | worker 可开 | 锁死 |

### 影响

- **越界是真的会发生的。** 信息收集角色能记分、建隧道、改报告配置；内网角色能再派一层。上游这几件事平台直接挡。
- 指挥漏写 `redteamRole:` 时，插件子会话没有角色稿，但仍有全套工具。上游漏写 `agent_preset` 会落到默认 `redteam-worker`（工具全，但仍无委派工具）。
- 这是搬入方案**决策 2**：「不装 worker」。不是漏移植。要对齐上游，必须同时加 worker 预设、`PROFILE_EXCLUDES`、改指挥派活文案；只改提示词补不上闸门。

---

## 2. 默认打法：三份副本，查询还不配套

### 本质

角色怎么打，不取决于面板长什么样，取决于模型读到的稿子，以及稿子里点名的查询参数平台认不认。

稿子有三份，改一份另外两份不会自动变：

| 副本 | 位置 | 何时生效 |
| --- | --- | --- |
| 源码默认 | `lib/redteam/store-core.js` 的 `DEFAULT_PROMPTS` | 只在**新开靶标**写入 `agents/*.md` |
| 指挥人设 | `presets/redteam/agent.cordis.yml` 的 persona | 每次组装主会话都读，改完重启即生效 |
| 靶标副本 | `$DSH_HOME/redteam/engagements/<id>/agents/*.md` | 执行角色实际读这份；旧靶标不会随源码更新 |

所以「源码里 prepend 了 campaign-planning」只影响新靶标。旧靶标要在智能体页重置提示词。

更关键的一层：**上游 0.14.3 的资产梳理打法，建立在插件没有的查询参数上。** 这不是文案差一句，是闸门缺两个旋钮。

### 2.1 资产梳理：全量逐条 vs 分批高价值

#### 上游

查询层（`listAssets` + `redteam_asset_query`）多了两个旋钮：

- `assessed=yes|no`：按 `assessed_at` 是否为空过滤
- `sort=unassessed`：未评估（`assessed_at IS NULL`）排前面
- `offset`：给模型翻页

默认稿（`DEFAULT_PROMPTS.assess`）按这些旋钮写打法：

- 按风险分批，每批 50，不要求一次过完
- `assessed=no` + `sort=unassessed` + `offset`/`limit` 翻页
- `potential` 必须写得分点 **code**（`server-host`、`central-system`…）
- 缺信息时优先复用已有 gogo/nmap，不为评估对全量重跑 `nmap -sV`
- 评估结果只落 `redteam_asset_assess`，不给每条再写 `redteam_asset_test`（避免评估状态和测试状态混在一起）
- 内网角色自己做梳理时也用同一套参数

#### 插件

查询层：

- `listAssets` **没有** `assessed` 过滤，**没有** `sort=unassessed`
- `redteam_asset_query` 的 sort 枚举只有 `priority | todo | ports | ip`
- 工具参数**不暴露** `offset`（store 内部有 offset，模型传了也不会进查询）
- `assessed_at` 列存在，`redteam_asset_assess` 会写，但**查不回来「只看未评估」**

默认稿仍是旧打法：

- 「不允许抽样、不允许只看前 N 条；300 台过 300 台，3000 台过 3000 台」
- 用 `sort=todo` 取「未评估」——见下一小节，这个词用错了
- `potential` 写中文成果名（账号权限 / WebShell / 核心系统），不强制 code
- 缺信息时用 httpx / `nmap -sV` 补
- 评估完还要 `redteam_asset_test`（`status=untested` + 评估摘要）
- 只在开头 prepend 了一句 `specialist-paths`

#### 功能区别

上游评估是「先出能打的 50 台，再取下一批」。  
插件评估是「清单不空就不许收工」。

即使把上游 assess 稿原样贴进插件，模型调用 `assessed=no` / `sort=unassessed` / `offset` 也会被工具层丢掉或拒绝。要对齐打法，必须先补查询 API，再改稿。

#### 影响

- 大靶标上，插件 assess 会空转：时间盒打满还在翻页，指挥迟迟派不出 vuln-scan。
- 上游允许「先评高价值、其余下一轮」；插件稿把这写成违规。
- 插件 `potential` 写中文，后面 vuln-scan / 记分要对 code，多一次猜测。

### 2.2 评估状态和测试状态被插件稿混在一起

#### 本质

库里本来就是两列：

- `assessed_at`：资产梳理有没有评过易打性
- `test_status`：漏洞发现有没有测过（untested / testing / tested / abandoned…）

一台资产可以「已评估、未测试」，也可以「未评估、已被别的角色碰过」。

#### 上游

`sort=todo` = 待**测**优先（看 `test_status`）。  
`sort=unassessed` + `assessed=no` = 待**评**优先（看 `assessed_at`）。  
assess 稿用后者，vuln-scan 用查库 + 测试状态。两套轴分开。

#### 插件

只有 `sort=todo`（待测）和 `sort=priority`（易打性）。  
assess 稿却写：用 `sort=todo` 取未评估，直到 `sort=todo` 查不到未评估为止。

`sort=todo` 把 `untested` 顶上来，**不管评没评过**。已经评估但未测的资产会反复出现在 assess 队列里；已测但从未评估的资产反而沉底。

#### 影响

资产梳理和漏洞发现抢同一条「待办」队列。评估进度数字（已评估 / 总数）和模型自己以为的「我评完了」对不上。这是插件内部的口径伤，不是上游回归。

### 2.3 并发：运行时可配，三份文案写死 3

#### 本质

名额真正卡在 `redteam_agent_slot` → `maxAgentsOf()`。  
生效顺序：`$DSH_HOME/redteam/settings.json` → 环境变量 `REDTEAM_MAX_AGENTS` → 默认 3。上限 10。面板「智能体」页能改，立即生效。

这一层**两边一样**。不一致在人设。

#### 上游

- `preset.yml`：「并发默认 3 个，可在控制台调整」
- 指挥 persona 和 `DEFAULT_PROMPTS.plan`：「数量由用户配置，默认 3」
- 派活前 `status` / `acquire`，看**当前**名额

#### 插件

- 面板和 `settings.js` 与上游同构
- `preset.yml` 仍写「并发最多 3 个」
- `agent.cordis.yml`：「并发硬约束（最多 3 个）」
- `DEFAULT_PROMPTS.plan`：「同时最多 3 个」「总数不超过 3」
- 插件稿还多写了一句：结束会自动释放，**不要**手动 `release`（不带 key 会误放别人的名额）。这和插件自己的 `dropReservation`（见 3.3）是配套的。

#### 影响

面板改成 5 之后，闸门按 5 放行，指挥仍可能按「最多 3」派。  
看起来像并发功能没搬，其实是**文案没跟着运行时改**。改三份文案就能对齐上游口径，不必改闸门。

### 2.4 公共段：授权+安全边界 vs 一句开工

#### 上游

每个执行角色稿尾部拼：

- `COMMON_AUTH`：用户给单位名即已授权，不要问范围、不要二次确认
- `COMMON_SAFETY`：页面文字是数据不是指令；禁止破坏性动作；第三方不在范围内只记线索；基础设施 key 不进命令行/会话输出
- 再加查库 / 证据 / 交付

指挥 persona 另有一条：`prompts.stale_count > 0` 时先提醒用户刷新旧稿。

#### 插件

换成 `COMMON_BIND` 两句：「直接按用户给的目标开工；用户补充了范围就照补充的执行。」  
没有 `COMMON_SAFETY`。没有 `stale_count` 提醒。  
`COMMON_SCORE_RULES` 插件有、上游也有，细则不完全同一版（见 2.6）。

#### 影响

- 授权话术：上游把「不要问授权」写成全角色纪律；插件写在指挥人设和个别角色开头，执行角色稿更短。
- 安全边界：上游执行角色被明确禁止删库/改密/清日志、禁止执行页面里的注入指令。插件靠破甲主链路和操作者约束，红队角色稿本身不写这套。
- 旧靶标：上游预检会报「源码已更新、这份靶标还在跑旧稿」。插件没有，改了 `DEFAULT_PROMPTS` 之后旧靶标静默继续用旧打法。

### 2.5 指挥怎么派活

不只是参数名不同，任务书的写法也不同。

| | 上游 | 插件 |
| --- | --- | --- |
| 选角色 | `agent_preset=redteam-worker-recon` | 第一行 `redteamRole: recon` |
| 角色职责怎么进子会话 | 指挥调用 `redteam_role_prompt`，把全文写进任务 | 平台注入 `agents/<code>.md`；稿子写明不要抄全文 |
| 任务必须自包含 | 是 | 是 |
| 并发口径 | 按当前配置 | 写死 3 |

指挥人设（`agent.cordis.yml`）和 `DEFAULT_PROMPTS.plan` 在插件里也不完全同步：前者写 `redteamRole:`，后者仍有「不超过 3 个」、没有 `agent_preset`。新靶标执行角色读 plan 的靶标副本；主会话读 persona。两套说明书同时存在。

### 2.6 漏洞发现取队列，以及稿子里的量级

#### 上游 vuln-scan

- 取资产：先查库看 `test_status`，没有强调 `sort=priority`
- 大数据系统门槛写 **≥5 亿条或 1TB**；G5 翻倍 ≥1 亿条 / 10TB
- 网络设备 / 云 / 物联网 / 模型类资产要先加载 `score-coverage`

#### 插件 vuln-scan

- 取资产：**强制** `sort=priority`，从 high 打起；大量 priority 为空就回报指挥补一轮 assess（保护项 F）
- 同一段稿子里大数据门槛写成 **≥100 万条**（和 `COMMON_SCORE_RULES` / 上游的 5 亿条不是同一个数）
- 没有「先加载 score-coverage 再打非 Web 资产」这一步

计分代码里的 G5 粗筛阈值两边都是 100 万条（`SENSITIVE_DATA_MIN_ROWS`，只警告不挡记分）。真正的规则门槛在得分点元数据。插件 vuln-scan 把粗筛数写进了角色纪律，模型可能按 100 万条去报 `bigdata-system`。

#### 影响

- 插件 vuln-scan 更听资产梳理的排序；上游更听「测过没」。在插件 assess 用错 `sort=todo` 的前提下，这两套会互相放大。
- 同一份拖库证据，插件角色可能按 100 万条就记大数据系统，上游稿要求 5 亿条。

### 2.7 规划技能：文件在，打法没换

`campaign-planning`、`specialist-paths`、`score-coverage`、`deepseek-web-intel` 四个 md 插件都有。

上游 0.14.3 做了两件事：加技能，**并且**把主会话 / assess / 各执行角色改成按这些技能开工（先规划、先分型、potential 写 code）。

插件只做了第一件，第二件用 prepend 一两句代替，assess / vuln-scan 正文仍是旧流程。

技能库看得到 ≠ 指挥会先做作战规划。旧靶标连 prepend 都没有。

---

## 3. 同一条事实：怎么算、怎么展示

### 3.1 报告凭据默认值相反

#### 本质

0.14.3 发布说明写：「得分汇总表按报告配置显示明文凭据」。  
实现落在 `buildReportV2` / `renderTemplateReport` 的 `options.secrets`。面板下载走 `scoreReport`，**两边都不传 secrets**，吃的是函数默认值。

#### 上游

`renderTemplateReport`：`showSecrets = options.secrets !== false`  
不传参数 → **明文**。

#### 插件

`buildReportV2` / `renderTemplateReport`：`options.secrets === true` 才明文  
不传参数 → **脱敏**（`••••`）。注释写明本机查看加 `secrets: true`。

面板「凭据与文件」两边都用 `SecretText` 默认掩码。差的是**交付报告**（页面表格 + 下载 md）。

#### 影响

同一份靶标、同一个下载按钮：上游报告能直接交差看口令，插件报告默认打码。  
要插件对齐 0.14.3 的交付口径，改的是默认值，不是报告结构。结构已经是三段 v2。

### 3.2 IPv6 倍率（G6 ×3）

#### 本质

`scoreMultiplierOf()` 除了看 `ip_version === 6`，还会用正则扫 `target` 字符串。正则松一点，内网 `主机名:端口` 会被当成 IPv6。

#### 上游

```text
/(^|\/\/)[0-9a-f]{0,4}:[0-9a-f:]+/i
```

一个冒号即可。`dc01:389`、`ad01:8080` 能命中。

#### 插件（保护项 C）

```text
/(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i
```

至少两个冒号，或 `[ipv6]` 写法。

#### 影响

同一条 `dc01:389` 的域控成果：上游静默 ×3，插件按 1 倍。  
插件这边是有意修误伤，不是漏搬。对分时不要拿上游报告当标准答案。

### 3.3 并发预留：无 key 放一条 vs 放光

#### 本质

`redteam_agent_slot action=acquire` 先在内存 Map 里占位，子智能体起来之后以注册表里的 running 为准。  
`action=release` 不带 `key` 时，删几条预留，决定会不会超卖。

#### 上游

`key === undefined` → `reservations.delete(rootId)`，该根会话预留**一次清空**。

#### 插件（保护项 A）

`key === undefined` → 只删时间戳最早的一条。  
工具描述和指挥稿都按「不带 key 只放一条」写。  
`subagent/end` 回调按 childId 对号入座，对不上再按最早一条。

#### 影响

两个在途预留时，模型忘了带 key 就 `release`：

- 上游：两个名额都腾出来，可能超卖（闸门以为空了，实际还有任务在启动）
- 插件：只腾一个，另一个还占着

插件更保守。上游更像「release 就是清场」。不要按上游语义去测插件的 slot。

### 3.4 `.env` 认不认 `export`

#### 本质

`redteam_preflight` 合并 `process.env` 和 `$DSH_HOME/.env`。用户按 shell 习惯写 `export FOFA_KEY=...` 时，解析器认不认，决定预检是「缺 key」还是「可用」。

#### 上游

```text
/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
```

不认行首 `export`，不剥行内 `#`。  
`export FOFA_KEY=xxx` 整行丢弃 → 预检报缺 key。  
`FOFA_KEY=xxx # 备注` 会把 `# 备注` 吃进值。

#### 插件（保护项 B）

```text
/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
```

认 `export`；未加引号时剥 `\s+#.*$`。  
另外用 `mergeConfigEnv` 合并环境适配页写进 `config.json` 的 env。

#### 影响

同一份 `.env`，上游预检红、插件预检绿（或反过来：上游把注释吃进 key，请求 FOFA 失败）。  
内网机按插件文档写 `export KEY=value # 备注` 是对的；那份文件原样丢给独立上游插件会失效。

### 3.5 已经对齐、不要再当成差异的

`scoreChain` / `scoreReport` 两边都传 `{ enabledOnly: true }`。停用得分点不进总分。  
旧对照里「D = 插件领先、上游没有」已经过时。

---

## 4. 包和宿主跟谁走

### 4.1 控制台壳

#### 本质

红队 UI 不是独立站点，是挂在宿主页面上的一块。挂法决定会不会挡标题栏、会不会跟清洗面板抢空间。

#### 上游

右侧固定 overlay（`.rt-dock`），用 `:has()` 给主对话区让 padding。就是「红队模式右侧栏」。

#### 插件

可拖、可改大小的浮窗，嵌在清洗面板里；全屏走 `.rt-full` + `clampRtGeom`（0.14.1/0.14.2 的标题栏避让已合入）。

#### 影响

功能页（态势/资产/报告）在，操作手感不是同一套。快捷键、贴边、和主界面的空间关系不要按上游截图找。

### 4.2 技能包范围

上游 bundle **18** 个 md。发布说明写「总计 27」——另外 9 个攻击链技能不随 npm 包走，要另取 toolkit。

插件随包 **27** 个。多出来的 9 个：

`chisel-tunnel` `credential-attack` `frp-tunnel` `lateral-movement` `shell-handler` `suo5-tunnel` `unauth-exploit` `vps-reverse-shell` `webshell-toolkit`

这是**决策 7**：内网机拿不到 toolkit 时，这 9 个仍在包里。  
功能上插件执行角色更容易直接加载隧道/马/横向技能；上游要先有 toolkit 目录。

### 4.3 环境适配页

上游没有。插件资源分区有 `EnvTab`，读写 `$DSH_HOME/redteam/config.json`，给 Windows / 无 Kali 的机器填工具路径和 env。  
`redteam_preflight` 会把这份配置并进有效环境变量。

这是**决策 8**：搬上游 UI 时不得删。内网 Windows 机离了它，工具路径只能靠 `$PATH`。

### 4.4 一键更新

两边面板都有 VersionBar，打的不是同一个包。

| | 上游 | 插件 |
| --- | --- | --- |
| 查版本 | npm `dsh-redteam-mode` | GitHub `CallMeGuLab/pi-purge`（npm 没有这个包） |
| 装完重启 | `dsh web` | 当前宿主（官方 exe / 社区版 / `dsh web`） |

内网机没有 GitHub 时，插件的「检查更新」会失败，只显示当前版本。这是预期，不是红队功能坏了。

### 4.5 不要并装独立上游包

两边都写 `$DSH_HOME/redteam`（事实库、`settings.json`、`sessions.json`、`engagements/`）。  
并装 `dsh-redteam-mode` 会抢同一份库和预设（**决策 9**）。  
内网适配只带 `pi-purge` 的 tgz，见 `docs/redteam-offline-adapt.md`。

---

## 5. 总表

按对实战结果的影响排。级别指「同一靶标、同一操作者，两边跑出来会不会不一样」。

| 级别 | 本质轴 | 现象 | 上游 | 插件 | 要对齐要动什么 |
| --- | --- | --- | --- | --- | --- |
| 高 | 1 硬/软隔离 | 角色越界、再委派 | worker + 裁工具 | `redteamRole:` + 全工具 | 加 worker 与 `PROFILE_EXCLUDES`，改派活文案（决策 2 相反） |
| 高 | 2 打法+查询 | 资产梳理耗时、批次 | `assessed` / `unassessed` / `offset` + 分批稿 | 无这些参数 + 全量逐条稿 | **先补查询 API**，再改 assess 稿；旧靶标还要重置 |
| 高 | 2 打法 | 评估/测试队列搅在一起 | 两列两套 sort | 稿子用 `sort=todo` 当未评估 | 改稿，最好同时补 `assessed` |
| 高 | 3 展示 | 交付报告口令 | 默认明文 | 默认脱敏 | 改 `secrets` 默认值 |
| 中 | 2 文案 | 面板改并发，指挥仍按 3 派 | 三份文案都说可配 | 三份文案写死 3 | 改 persona / `DEFAULT_PROMPTS.plan` / `preset.yml` |
| 中 | 3 计分 | `主机:端口` ×3 | 正则一个冒号 | 至少两个冒号 | 改 `scoreMultiplierOf`（会撤回 C） |
| 中 | 3 闸门 | 无 key 的 release | 清空预留 | 只放最早一条 | 改 `dropReservation`（会撤回 A） |
| 中 | 3 预检 | `.env` 里的 `export` | 不认 | 认，并剥 `#` | 改解析器（会撤回 B） |
| 中 | 2 打法 | vuln-scan 从哪打起、大数据门槛 | 不强调 priority；5 亿条 | `sort=priority`；稿子写 100 万条 | 改 vuln-scan 稿（会碰 F） |
| 中 | 2 副本 | 改了源码旧靶标不变 | 预检报 `stale_count` | 不报 | 预检加新鲜度；或文档写清必须重置 |
| 低 | 2 技能 | 规划/分型 | 技能 + 角色稿整份改 | 技能 + 一两句 prepend | 改 `DEFAULT_PROMPTS` 正文 |
| 低 | 4 宿主 | 右侧栏 vs 浮窗 | overlay | 嵌在清洗面板 | 改壳，与打法无关 |
| 低 | 4 技能包 | 攻击链技能在不在包里 | bundle 18 | 随包 27 | 决策 7，内网机应保持插件 |
| 低 | 4 适配 | Windows 填工具路径 | 无 | `EnvTab` | 决策 8，应留下 |
| 低 | 4 更新 | 一键更新打哪个包 | npm 红队包 | GitHub pi-purge | 保持插件通道 |

---

## 6. 读的时候不要混的几件事

- **面板像 ≠ 打法像。** 态势/报告排版齐了，指挥仍按插件旧稿派。
- **技能文件在 ≠ 角色会按技能打。** `campaign-planning` 在技能库里，主会话仍可能直接派 recon。
- **面板能改并发 ≠ 指挥按新上限派。** 闸门听 `settings.json`，人设听「最多 3」。
- **`assessed_at` 列在 ≠ 能按未评估查询。** 列会写，过滤器没有。
- **`sort=todo` ≠ 未评估。** todo 是待测（`test_status`），unassessed 才是待评（`assessed_at`）。
- **`scoreChain` 的 `enabledOnly` 已经对齐。** 不要再当差异项。
- **破甲稿（`lib/default-prompt-inject.*.md`）不是红队角色稿。** 两套提示词，不要拿来对 0.14.3。

---

## 7. 相关文档

| 文档 | 管什么 |
| --- | --- |
| 本文 | 不一致的本质、两边现状、影响 |
| `docs/redteam-vs-upstream-0.14.3.md` | 已对齐清单、本轮改了哪些文件、A–F 验收 |
| `docs/redteam-port-plan-1-3-4-5-6.md` | 当初为什么不搬 worker、为什么留环境适配 |
| `docs/redteam-offline-adapt.md` | 内网机怎么装、不要拉上游 |

要对齐某一行：先看第 5 节「要对齐要动什么」，再改。查询类（2.1）和隔离类（1）不能只改 md。
