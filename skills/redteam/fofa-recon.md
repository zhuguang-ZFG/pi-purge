---
name: fofa-recon
description: 【侦察】用 FOFA API 批量测绘靶标资产（域名/IP/端口/标题/指纹）；同时支持官方 fofa.info 与第三方中转接口，内置限速客户端（单线程 + 最小间隔 + 退避重试）
whenToUse: 信息收集阶段需要快速铺开某单位/域名的互联网资产面时
role: recon
category: 侦察
tags: [external, asset, fofa]
enabled: true
---

# FOFA 资产测绘（限速安全版）

## 凭据与后端

脚本按下面的顺序取配置，**key 绝不写进仓库**：

1. 环境变量 `FOFA_KEY` / `FOFA_BASE` / `FOFA_BACKEND`
2. `$DSH_HOME/redteam/config.json` 的 `env.FOFA_KEY` / `env.FOFA_BASE`
3. 都没有 → 直接报错退出，不要瞎猜

| 后端 | `FOFA_BACKEND` | 接口 | 鉴权 | 单页上限 |
|---|---|---|---|---|
| 官方 | `official`（默认） | `GET {base}/api/v1/search/all` | 查询参数 `key` + `qbase64` | size ≤ 1000 |
| 中转 | `relay` | `POST {base}/api/search` | 请求头 `X-API-Key` | size 2–50，且 page×size ≤ 60 |

`FOFA_BASE` 指向中转域名（如 `https://fofa.ssgonet.com`）时，脚本会自动判定为 `relay`；也可用 `FOFA_BACKEND` 强制指定。

### 两种后端的差异（实测）

| 项 | 官方 fofa.info | 中转（ssgonet 一类） |
|---|---|---|
| 请求方式 | GET | POST JSON |
| key 传法 | `?key=` 查询参数 | `X-API-Key` 请求头 |
| 查询语句 | base64 后的 `qbase64` | JSON 里原样 `query` |
| 返回结构 | `{error, results:[[...]], size}` | `{code:0, total, remaining_today, assets:[{...}]}` |
| 错误形态 | HTTP 200 + `error:true` | `code != 0` |
| 单次结果上限 | size 可到 1000 | **60 条**（page×size ≤ 60） |
| 额度耗尽 | `[45012]` 或 `[-700]` | `code != 0` + message |

## 官方限额（fofa.info，2026-09 核对）

| 会员 | 查询请求 | 获取数据量 | **查询接口并发** |
|---|---|---|---|
| 注册用户（免费） | 无 API（页面 300 次/月） | 页面 3,000 条/月 | — |
| 个人版 | 10,000 次/月 | 100,000 条/月 | **1 秒 1 次** |
| 专业版 | 80,000 次/月 | 800,000 条/月 | **1 秒 1 次** |
| 商业版 | 900,000 次/月 | 9,000,000 条/月 | **1 秒 2 次** |
| 企业版 V2 | 5,000,000 次/月 | 50,000,000 条/月 | **1 秒 5 次** |

## 实测行为

- 连续快速请求 → **HTTP 429**，响应体 `{"error":true,"errmsg":"[45012] 请求速度过快"}`
- key 错误（官方）→ HTTP 200 + `{"error":true,"errmsg":"[-700] 账号无效"}`
- key 错误（中转）→ `{"code":非0,...}`
- 官方单页 `size` 到 1000 正常；请求间隔 ≥1 秒时连续请求均返回 200
- 中转单页最大 50，且 `page × size ≤ 60`，越界返回 400
- 结论：**按 1 请求/秒 保守执行，绝不并发**；遇到 45012 / 429 必须退避，不要立即重试

## 使用纪律（重要）

1. **精确查询优先**：`domain=` / `cert=` / `org=` 先缩小范围，再考虑 `body=` / `title=` 等宽泛语句。宽语句返回几十万条没意义，还烧配额。
2. **不要全量翻页**：中转后端一次查询最多只有 60 条，需要更多时按切片查询拆分（见下）。
3. **单进程单线程**：同一时刻只跑一个采集任务；多个查询串行排队。
4. **结果落盘缓存**：同一查询不要重复拉，先看 `runs/fofa-*.jsonl` 是否已有。
5. **长任务放后台**：用 `run_in_background` 跑，别阻塞对话。
6. 配额耗尽或被限速时改用其他数据源（证书透明、DNS、搜索引擎），不要死磕。

## 限速客户端（用这个，不要手写 curl 循环）

```bash
mkdir -p runs
cat > runs/fofa_client.py <<'PY'
#!/usr/bin/env python3
"""FOFA 采集（限速安全）：单线程 + 最小间隔 + 指数退避 + 结果缓存。
同时支持官方 fofa.info 与第三方中转（X-API-Key）。

用法:
  python3 runs/fofa_client.py 'domain="example.com"' --pages 2 --size 50 --interval 2.0
  python3 runs/fofa_client.py 'title="登录"' --backend official --pages 1 --size 100
  FOFA_BASE=https://fofa.ssgonet.com python3 runs/fofa_client.py 'ip="203.0.113.0/24"'

输出:
  runs/fofa-<slug>.jsonl   每行一个资产
"""
import argparse, base64, hashlib, json, os, sys, time
import urllib.error, urllib.parse, urllib.request

RETRY_BACKOFF = [5, 15, 45]     # 限速退避秒数
HARD_BUDGET = 30                # 单次运行最多请求次数
UA = "redteam-recon/1.0"


# ───────────── 配置装载 ─────────────
def load_conf():
    key = (os.environ.get("FOFA_KEY") or "").strip()
    base = (os.environ.get("FOFA_BASE") or "").strip().rstrip("/")
    backend = (os.environ.get("FOFA_BACKEND") or "").strip().lower()

    if not key or not base:
        home = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
        cfg = os.path.join(home, "redteam", "config.json")
        try:
            with open(cfg, encoding="utf-8") as f:
                env = (json.load(f).get("env") or {})
            key = key or (env.get("FOFA_KEY") or "").strip()
            base = base or (env.get("FOFA_BASE") or "").strip().rstrip("/")
            backend = backend or (env.get("FOFA_BACKEND") or "").strip().lower()
        except Exception:
            pass

    base = base or "https://fofa.info"
    if not backend:
        backend = "relay" if ("ssgonet" in base or "/api/search" in base) else "official"
    return key, base, backend


# ───────────── 两个后端 ─────────────
def _http(url, payload=None, headers=None, timeout=30):
    hdr = {"User-Agent": UA}
    if headers:
        hdr.update(headers)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"_raw": body[:300]}


def search_official(base, key, query, page, size, fields):
    qs = urllib.parse.urlencode({
        "key": key,
        "qbase64": base64.b64encode(query.encode()).decode(),
        "size": size, "page": page, "fields": fields,
    })
    status, d = _http(base + "/api/v1/search/all?" + qs)
    if status == 200 and not d.get("error"):
        rows = []
        for item in d.get("results") or []:
            if isinstance(item, str):
                item = [item]
            names = fields.split(",")
            rec = {n: (item[i] if i < len(item) else "") for i, n in enumerate(names)}
            rows.append(rec)
        return status, {"ok": True, "rows": rows, "total": d.get("size"),
                        "remain": d.get("consumed_fpoint"), "raw": d}
    return status, {"ok": False, "errmsg": str(d.get("errmsg") or d.get("_raw") or d)}


def search_relay(base, key, query, page, size):
    url = base + "/api/search"
    status, d = _http(url, {"query": query, "page": page, "size": size},
                      {"X-API-Key": key})
    if status == 200 and d.get("code") == 0:
        rows = []
        for a in d.get("assets") or []:
            rows.append({k: a.get(k, "") for k in
                         ("host", "ip", "port", "title", "domain", "server",
                          "protocol", "country", "region", "city", "org")})
        return status, {"ok": True, "rows": rows, "total": d.get("total"),
                        "remain": d.get("remaining_today"),
                        "warning": d.get("warning") or "", "raw": d}
    return status, {"ok": False, "errmsg": str(d.get("message") or d.get("_raw") or d)}


# ───────────── 主流程 ─────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--pages", type=int, default=2, help="最多翻页数（官方默认 2）")
    ap.add_argument("--size", type=int, default=0, help="每页条数；0=按后端自动（官方100/中转50）")
    ap.add_argument("--interval", type=float, default=2.0, help="请求最小间隔秒")
    ap.add_argument("--backend", choices=["official", "relay"], default="", help="强制后端")
    ap.add_argument("--fields", default="host,ip,port,title,domain,server,protocol",
                    help="仅官方后端有效")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    key, base, backend = load_conf()
    if args.backend:
        backend = args.backend
    if not key:
        print("[fatal] 没有 FOFA key：设 FOFA_KEY，或写进 $DSH_HOME/redteam/config.json 的 env.FOFA_KEY", file=sys.stderr)
        return 2

    size = args.size or (50 if backend == "relay" else 100)
    if backend == "relay" and (size < 2 or size > 50):
        print(f"[fatal] 中转后端 size 必须在 2–50，当前 {size}", file=sys.stderr)
        return 2
    if backend == "relay" and args.pages * size > 60:
        print(f"[fatal] 中转后端 page×size 不能超过 60（当前 {args.pages}×{size}）", file=sys.stderr)
        return 2

    slug = hashlib.md5(("%s|%s" % (backend, args.query)).encode()).hexdigest()[:8]
    out = args.out or f"runs/fofa-{slug}.jsonl"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    if os.path.exists(out) and os.path.getsize(out) > 0:
        print(f"[cache] {out} 已存在（{os.path.getsize(out)} bytes），如需重拉请先删除", file=sys.stderr)
        return 0

    print(f"[conf] backend={backend} base={base} size={size} pages={args.pages}", file=sys.stderr)

    seen, rows, made, last_ts, total, remain = set(), [], 0, 0.0, None, None
    for page in range(1, args.pages + 1):
        wait = args.interval - (time.time() - last_ts)
        if wait > 0:
            time.sleep(wait)

        res = None
        for attempt, backoff in enumerate([0] + RETRY_BACKOFF):
            if attempt:
                print(f"[backoff] 等待 {backoff}s 后重试 (page={page})", file=sys.stderr)
                time.sleep(backoff)
            last_ts = time.time()
            made += 1
            if made > HARD_BUDGET:
                print(f"[stop] 达到请求预算 {HARD_BUDGET}", file=sys.stderr)
                break
            if backend == "relay":
                status, res = search_relay(base, key, args.query, page, size)
            else:
                status, res = search_official(base, key, args.query, page, size, args.fields)
            if res.get("ok"):
                break
            msg = res.get("errmsg", "") or ""
            if status == 429 or "45012" in msg or "过快" in msg or "rate" in msg.lower():
                continue                      # 限速 → 退避重试
            print(f"[stop] 不可重试错误 http={status} {msg}", file=sys.stderr)
            res = None
            break
        if not res:
            break

        total = res.get("total", total)
        remain = res.get("remain", remain)
        page_rows = res.get("rows") or []
        print(f"[page {page}] {len(page_rows)} 条 total={total} remain={remain} {res.get('warning','')}",
              file=sys.stderr)
        for rec in page_rows:
            k = (rec.get("host"), rec.get("ip"), rec.get("port"))
            if k in seen:
                continue
            seen.add(k)
            rows.append(rec)
        if len(page_rows) < size:
            break

    with open(out, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"[done] {len(rows)} 条资产 → {out}（共 {made} 次请求，总匹配 {total}，剩余 {remain}）",
          file=sys.stderr)
    return 0


def flag_msg(m):
    return m if isinstance(m, str) else ""


if __name__ == "__main__":
    sys.exit(main())
PY
```

### 用法

```bash
mkdir -p runs

# 自动读 $DSH_HOME/redteam/config.json 里的 FOFA_KEY / FOFA_BASE
python3 runs/fofa_client.py 'domain="example.com"' --pages 1 --size 50
python3 runs/fofa_client.py 'cert="example.com"' --pages 1
python3 runs/fofa_client.py 'org="示例科技有限公司"' --pages 1

# 临时指定后端与 key
FOFA_BASE=https://fofa.ssgonet.com FOFA_KEY=xxxx python3 runs/fofa_client.py 'ip="203.0.113.0/24"'
FOFA_KEY=xxxx python3 runs/fofa_client.py 'title="登录"' --backend official --size 100
```

### 突破中转单次 60 条上限（切片查询）

中转后端 `page × size ≤ 60`，要覆盖更多资产就按 IP 段或端口切片，每条独立查询：

| 切片维度 | 语句模板 |
|---|---|
| 按端口 | `ip="203.0.113.0/24" && port="80"` / `port="443"` / `port="8080"` … |
| 按 C 段 | `ip="203.0.113.0/24"`、`ip="203.0.113.1/24"` … 逐段拆 |
| 按标题 | `domain="x.com" && title="后台"` / `title="登录"` … |
| 按证书 | `cert="x.com" && port="443"` |

每个切片用不同 `--out` 落盘，最后合并去重。

### 落库

读 `runs/fofa-*.jsonl`，逐条 `redteam_asset_add`：`provenance="passive"`、`tool="fofa"`，端口带 `url=host`、`title`、`product=server`；域名写进 `names`。

## 常用查询语句

| 目的 | 语句 |
|---|---|
| 某域名全部资产 | `domain="example.com"` |
| 证书包含该域名 | `cert="example.com"` |
| 某 C 段 | `ip="203.0.113.0/24"` |
| 单位名称 | `org="示例科技有限公司"` |
| 按标题找后台 | `title="登录" && domain="example.com"` |
| 按 body 特征 | `body="/seeyon/"` |
| 指定端口 | `ip="203.0.113.0/24" && port="3306"` |

> 宽泛语句（单独用 `body=` / `title=`）结果量大、消耗配额快，务必叠加域名或 IP 限定。
