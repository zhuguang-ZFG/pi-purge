# pi-purge 改造说明（相对上游 dsh-purge-safe 2.0.0）

本文件记录从 [dsh-purge-safe](https://github.com/CallMeGuLab/dsh-purge-safe) 改名为 `pi-purge` 的全部改动，便于比对与回滚。

## 一、改名映射表

| 上游 | pi-purge | 说明 |
|---|---|---|
| `dsh-purge-safe` | `pi-purge` | 包名、路径、路由、配置段、数据目录、备份后缀、文案 |
| `DSH-PURGE-SAFE` | `PI-PURGE` | 全大写形态 |
| `DSH_PURGE` | `PI_PURGE` | 常量前缀（`DSH_PURGE_RESTART` → `PI_PURGE_RESTART` 等） |
| `dshPurge` | `piPurge` | 驼峰内部标记（`__dshPurgeSpawnOrig` 等） |
| `dshPurgeDrill` | `piPurgeDrill` | 嵌入式演练台全局变量 |
| `dshpurge` | `pipurge` | 小写连写（备份后缀 `.dshpurge.bak` → `.pipurge.bak`） |
| `dshpg` | `pipg` | 提示词段名前缀（`dshpg-objective` → `pipg-objective`） |

文件改名：`bin/dsh-purge-safe.js` → `bin/pi-purge.js`

## 二、**故意没有改**的名称

| 名称 | 原因 |
|---|---|
| `dsh-purgee` | 上游历史别名。`lib/redteam/index.js` 的 `renderToolsPackage()` 要把 `dsh-redteam-mode/*`、`dsh-purgee/redteam/tools`、`dsh-purge/redteam/tools`、`dsh-purge/tools` 全部归一成当前包名。改了它，老用户副本上的工具行就解析不到，整份预设会变成 `registered-broken`，模式下拉里看不到「红队模式」。 |
| `CallMeGuLab` | 上游作者署名。Apache-2.0 要求保留。 |
| `/purge` 斜杠命令 | 会话里的命令名，改名会让所有现存习惯与文档失效；上游本来就叫 `/purge`，与包名解耦。 |

## 三、仓库身份

| 位置 | 改动 |
|---|---|
| `package.json` | 补 `repository` / `homepage` / `bugs` / `author`，`name` 改 `pi-purge` |
| `NOTICE` | 增加上游来源声明 + 本仓库地址，保留上游版权行 |
| `README*.md` ×4 | 「二开必须署名」章节重写为「本项目为二开作品」：先声明上游作者与著作权归属，再要求下游同时署名本仓库与上游 |
| `.github/workflows/release.yml` | `if: github.repository ==` 与 release URL 指向 `zhuguang-ZFG/pi-purge` |
| `lib/update.js` | `const REPO` 由空串改为 `"zhuguang-ZFG/pi-purge"` |

## 四、改名后的兼容性验证（全部通过）

```
JS 语法         68 个文件 node --check        0 失败
ESM 导入        19 个模块 import()            全部 OK
                 （lib/redteam/tools.js 依赖宿主 @deepseek-ai/dsh-tools，脱离宿主报错属预期）
补丁注册表      ALL_PATCHES = 59              id 1–96 完整
CLI             pi-purge --help / --status    正常
注入解析        rules.resolveInjectText()     返回 default，24298 字符
override 写入   core.installOverride()        写出 26824 字节
构建幂等        node scripts/build-client.mjs client.js 哈希前后一致
npm pack        pi-purge-2.0.0.tgz            1.36 MB / 149 条目
                bin/pi-purge.js、skills 40 个、presets 齐全
                无 .git / node_modules / default-prompt-inject.md 泄漏
旧名残留        dsh-purge-safe / DSH_PURGE / dshpg / dshPurge / dshpurge = 0
                （仅剩 README/NOTICE/package.json 里的上游署名引用，属故意保留）
```

## 五、宿主侧路径变化

改名后运行时落在宿主上的路径全部跟着变，与上游互不干扰：

| 用途 | 上游 | pi-purge |
|---|---|---|
| 数据目录 | `$DSH_HOME/dsh-purge-safe/` | `$DSH_HOME/pi-purge/` |
| 覆盖状态 | `.../override-state.json` | 同名，父目录不同 |
| 宿主备份 | `$DSH_HOME/dsh-purge-safe/host-backups/` | `$DSH_HOME/pi-purge/host-backups/` |
| 文件备份后缀 | `<file>.dshpurge.bak` | `<file>.pipurge.bak` |
| shim 标记 | `dsh-purge-safe shim begin` | `pi-purge shim begin` |
| 补丁注释标记 | `[dsh-purge-safe] ...` | `[pi-purge] ...` |
| 提示词段名前缀 | `dshpg-*` | `pipg-*` |
| HTTP 路由 | `/dsh-purge-safe/*` | `/pi-purge/*` |
| 环境变量 | `DSH_PURGE_RESTART` | `PI_PURGE_RESTART` |
| 浏览器存储键 | `dsh-purge-safe-ui-theme` 等 | `pi-purge-ui-theme` 等 |

**注意**：同一宿主上不要同时 Apply 上游与 pi-purge 两套补丁。两者补丁标记互不识别，重复 Apply 会在同一文件上叠两层改动；回滚时只认自己那套标记，可能留下对方的残留。切换前先对旧的一套执行 `--revert`。

## 六、验证过程中的一次失误（记录在案）

在验证 `core.applyPatchesAllHosts()` 时，`enumeratePatchAiBases()` 会自行探测本机已安装的 DeepSeek Harness，不读 `DSH_BASE`，于是把 pi-purge 的 59 个补丁打到了本机真实宿主上（非有意）。

处理过程：

1. 立即 `core.revertAllHosts()` 回滚，47 个文件还原；
2. 逐文件 SHA-256 与 `.pipurge.bak` 比对，55/55 全部一致，确认无内容损毁；
3. 确认回滚完成后才删除 `.pipurge.bak`，并清掉 `$DSH_HOME/pi-purge/` 下的 47 条备份记录；
4. 复核宿主上 `[pi-purge]` 标记数 = 0、`.pipurge.bak` 数 = 0，宿主回到验证前状态。

结论：改名不改变补丁逻辑本身，apply/revert 成对可用；但**在已装 DSH 的机器上做验证要特别小心**，apply 会命中真实安装。后续同类验证应改用不含官方安装的独立机器或在容器内进行。
