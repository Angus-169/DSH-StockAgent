"""
collector.py — 历史数据采集与落库

职责：
  1. 从 MarketService 的 HTTP 路由（/stock-lab/kline）拉取 K 线
  2. 归一化为统一 schema 后交给 storage.save_bars
  3. 记录采集元信息（来源、时间、行数）

为什么用 HTTP 而不是 Python 直连行情接口：
  ARCHITECTURE §2 的硬规则——所有数据访问必须经 MarketService。
  Python 侧只做「存储 + 计算」，不拥有自己的数据源适配器。

用法：
  python backend/collectors/collector.py fetch SH600519 --count 500
  python backend/collectors/collector.py fetch-many SH600519 SZ300750 --count 500
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

# Windows 控制台默认 GBK，会因 ✓/✗ 等字符抛 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "storage"))

import pandas as pd  # noqa: E402

from storage import data_version, list_bars_meta, load_bars, save_bars  # noqa: E402

DEFAULT_BASE = os.environ.get("DSH_STOCK_LAB_URL", "http://127.0.0.1:54358")


def _api(base: str, path: str, params: dict | None = None, timeout: float = 30.0) -> dict:
    url = base.rstrip("/") + "/stock-lab" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"接口返回失败: {payload.get('error')}")
    return payload["data"]


def fetch_bars(
    symbol: str,
    *,
    timeframe: str = "1d",
    adjust: str = "qfq",
    count: int = 500,
    base: str = DEFAULT_BASE,
) -> dict:
    """从一个标的抓取 K 线并落库。"""
    bars = _api(base, "/kline", {
        "symbol": symbol, "timeframe": timeframe, "adjust": adjust, "count": count,
    })
    if not isinstance(bars, list) or not bars:
        raise RuntimeError(f"{symbol} 未取到 K 线（返回 {type(bars).__name__}）")

    df = pd.DataFrame(bars)
    # 统一 schema 校验：必须有 time/open/high/low/close/volume
    for col in ("time", "open", "high", "low", "close", "volume"):
        if col not in df.columns:
            raise RuntimeError(f"{symbol} 缺少字段 {col}，实际列: {list(df.columns)}")
    sources = df["source"].dropna().unique().tolist() if "source" in df.columns else ["unknown"]
    source = ",".join(str(s) for s in sources) or "unknown"

    meta = save_bars(symbol, df, timeframe=timeframe, adjust=adjust, source=source)
    return meta


def fetch_many(
    symbols: list[str],
    *,
    timeframe: str = "1d",
    adjust: str = "qfq",
    count: int = 500,
    base: str = DEFAULT_BASE,
) -> list[dict]:
    out = []
    for i, s in enumerate(symbols, 1):
        try:
            meta = fetch_bars(s, timeframe=timeframe, adjust=adjust, count=count, base=base)
            print(f"  [{i}/{len(symbols)}] {s} ✓ {meta['rows']} 行 "
                  f"({meta['first_bar']} ~ {meta['last_bar']}, {meta['source']})")
            out.append(meta)
        except Exception as e:
            print(f"  [{i}/{len(symbols)}] {s} ✗ {e}")
            out.append({"symbol": s, "error": str(e)})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Stock Lab 历史数据采集")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("fetch", help="抓取单个标的")
    p1.add_argument("symbol")
    p1.add_argument("--timeframe", default="1d")
    p1.add_argument("--adjust", default="qfq")
    p1.add_argument("--count", type=int, default=500)
    p1.add_argument("--base", default=DEFAULT_BASE)

    p2 = sub.add_parser("fetch-many", help="抓取多个标的")
    p2.add_argument("symbols", nargs="+")
    p2.add_argument("--timeframe", default="1d")
    p2.add_argument("--adjust", default="qfq")
    p2.add_argument("--count", type=int, default=500)
    p2.add_argument("--base", default=DEFAULT_BASE)

    p3 = sub.add_parser("status", help="查看已落库的数据")
    p3.add_argument("--symbol")

    p4 = sub.add_parser("version", help="打印数据版本指纹（供 Research Note 记录）")
    p4.add_argument("symbols", nargs="+")

    args = ap.parse_args()

    if args.cmd == "fetch":
        print(json.dumps(fetch_bars(args.symbol, timeframe=args.timeframe, adjust=args.adjust,
                                    count=args.count, base=args.base), ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "fetch-many":
        res = fetch_many(args.symbols, timeframe=args.timeframe, adjust=args.adjust,
                         count=args.count, base=args.base)
        ok = sum(1 for r in res if "error" not in r)
        print(f"\n完成 {ok}/{len(res)}")
        # 最后一行输出机器可读的 JSON，供 Node 侧解析
        print("__JSON__" + json.dumps({
            "ok": ok, "total": len(res), "results": res,
        }, ensure_ascii=False))
        return 0 if ok == len(res) else 1

    if args.cmd == "status":
        metas = list_bars_meta()
        if args.symbol:
            metas = [m for m in metas if m["symbol"] == args.symbol]
        if not metas:
            print("尚无落库数据")
        else:
            for m in metas:
                print(f"{m['symbol']:10} {m['timeframe']:3} {m['adjust']:5} "
                      f"{m['rows']:5} 行  {m['first_bar']} ~ {m['last_bar']}  "
                      f"{m['backend']:6}  {m['source']}  @{m['fetched_at'][:19]}")
        print("__JSON__" + json.dumps({
            "count": len(metas),
            "symbols": [
                {k: m[k] for k in ("symbol", "timeframe", "adjust", "rows",
                                   "first_bar", "last_bar", "source", "backend", "fetched_at")}
                for m in metas
            ],
        }, ensure_ascii=False))
        return 0

    if args.cmd == "version":
        print(data_version(args.symbols))
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
