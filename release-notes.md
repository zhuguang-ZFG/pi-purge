# 2.0.0

pi-purge 首个版本：从 dsh-purge-safe 2.0.0 二开，整体重命名为 pi-purge。

## 中文

- 本项目是 [dsh-purge-safe](https://github.com/CallMeGuLab/dsh-purge-safe)（作者 CallMeGuLab）的二开版本，按 Apache-2.0 保留上游署名。
- 包名、CLI、模块 id、HTTP 路由、配置段、数据目录、备份后缀整体改为 `pi-purge`。
- 适配 **DeepSeek Harness 0.2.2-rc.3**，保留 **Super Agent** 支持。
- 上游的历史别名兼容逻辑（`dsh-redteam-mode` / `dsh-purgee` / 旧红队包名归一）原样保留，老用户副本升级不会断。
- 保留 59 个补丁定义、40 个红队技能、演练台与清洗两套面板。

## English

- Derivative of [dsh-purge-safe](https://github.com/CallMeGuLab/dsh-purge-safe) by CallMeGuLab, redistributed under Apache-2.0 with upstream attribution preserved.
- Package name, CLI, module id, HTTP routes, config section, data directory and backup suffix all renamed to `pi-purge`.
- Adapted for **DeepSeek Harness 0.2.2-rc.3**, **Super Agent** support retained.
- Upstream legacy aliases (`dsh-redteam-mode` / `dsh-purgee` / older red-team package names) are preserved verbatim so existing copies keep resolving.
- All 59 patch definitions, 40 red-team skills, drill console and clean panel retained.

## 日本语

- [dsh-purge-safe](https://github.com/CallMeGuLab/dsh-purge-safe)（作者 CallMeGuLab）の二次開発版です。Apache-2.0 に従い上流の帰属表示を保持しています。
- パッケージ名、CLI、モジュール id、HTTP ルート、設定セクション、データディレクトリ、バックアップ接尾辞を `pi-purge` に統一しました。
- **DeepSeek Harness 0.2.2-rc.3** に対応し、**Super Agent** サポートを維持します。
- 上流の旧別名（`dsh-redteam-mode` / `dsh-purgee` / 旧レッドチームパッケージ名）はそのまま保持し、既存コピーの解決を壊しません。
- 59 個のパッチ定義、40 個のレッドチームスキル、ドリルコンソールとクリーンパネルを維持します。

## 安装与更新

使用解压后的本地目录安装，Web 与桌面端分开安装、分开应用。当前为本地固定版本，在线更新与通道切换已关闭。改名后首次安装请把插件目录放到 `$DSH_HOME/plugins/pi-purge`，profile 的 `dependencies` 与 `dsh.profile.bundles` 都写 `pi-purge`。详细步骤见 [中文 README](./README.zh-CN.md)。

> 与上游 `dsh-purge-safe` 并存时注意：两者数据目录、备份后缀、override 文件互不相同（`pi-purge` vs `dsh-purge-safe`），不会互相覆盖；但同一份宿主上不要同时 Apply 两套补丁。
