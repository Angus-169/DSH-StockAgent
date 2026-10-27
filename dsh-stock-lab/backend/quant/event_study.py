"""
event_study.py — 事件研究（Event Study）

用途（ARCHITECTURE §14）：
  用户提出一个可检验的研究假设，例如：
    "某股票放量突破后，未来 5 日是否更容易跑赢沪深300？"
  本模块把假设转成事件样本，统计事件后 N 日的平均超额收益与显著性。

设计原则：
  - 所有统计量由代码计算，LLM 只解释结果（原则 3）
  - 明确输出样本量、显著性、以及"不构成因果"的提示
  - 无未来函数：事件判定用当日及之前的数据，收益用事件后的数据

单独运行：
  python backend/quant/event_study.py --symbol SH600519 --condition volume_spike --horizon 5
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "storage"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from storage import load_bars  # noqa: E402


# ---------------------------------------------------------------------------
# 内置条件（事件定义）
# ---------------------------------------------------------------------------

def _cond_volume_spike(df: pd.DataFrame, params: dict) -> pd.Series:
    """成交量显著放大：当日量 / 前 N 日均量 >= 阈值"""
    n = int(params.get("n", 20))
    mult = float(params.get("mult", 1.5))
    ma = df["volume"].rolling(n).mean().shift(1)
    return (df["volume"] / ma) >= mult


def _cond_breakout(df: pd.DataFrame, params: dict) -> pd.Series:
    """突破 N 日新高（收盘价创前 N 日最高）"""
    n = int(params.get("n", 20))
    hi = df["high"].rolling(n).max().shift(1)
    return df["close"] > hi


def _cond_drawdown(df: pd.DataFrame, params: dict) -> pd.Series:
    """从 N 日高点回撤超过阈值"""
    n = int(params.get("n", 20))
    pct = float(params.get("pct", 0.1))
    hi = df["high"].rolling(n).max().shift(1)
    return (df["close"] / hi - 1) <= -pct


def _cond_ma_cross(df: pd.DataFrame, params: dict) -> pd.Series:
    """短期均线上穿长期均线"""
    fast = int(params.get("fast", 5))
    slow = int(params.get("slow", 20))
    ma_f = df["close"].rolling(fast).mean()
    ma_s = df["close"].rolling(slow).mean()
    return (ma_f > ma_s) & (ma_f.shift(1) <= ma_s.shift(1))


def _cond_big_move(df: pd.DataFrame, params: dict) -> pd.Series:
    """单日涨跌幅超过阈值（正负均可，pct 为绝对值）"""
    pct = float(params.get("pct", 0.05))
    ret = df["close"].pct_change()
    return ret.abs() >= pct


CONDITIONS = {
    "volume_spike": (_cond_volume_spike, "成交量显著放大（当日量/前N日均量 ≥ mult）"),
    "breakout": (_cond_breakout, "突破 N 日新高"),
    "drawdown": (_cond_drawdown, "从 N 日高点回撤超过阈值"),
    "ma_cross": (_cond_ma_cross, "短期均线上穿长期均线"),
    "big_move": (_cond_big_move, "单日涨跌幅超过阈值"),
}


# ---------------------------------------------------------------------------
# 核心计算
# ---------------------------------------------------------------------------

def run_event_study(
    symbol: str,
    condition: str,
    *,
    params: dict | None = None,
    horizon: int = 5,
    benchmark: str = "IDX000300",
    timeframe: str = "1d",
    adjust: str = "qfq",
) -> dict:
    """对一个条件做事件研究，返回事件样本与统计检验结果。"""
    params = params or {}
    if condition not in CONDITIONS:
        raise ValueError(f"未知条件 {condition}，可用: {', '.join(CONDITIONS)}")
    fn, desc = CONDITIONS[condition]

    stock = load_bars(symbol, timeframe=timeframe, adjust=adjust)
    bench = load_bars(benchmark, timeframe=timeframe, adjust=adjust)
    if stock.empty:
        raise RuntimeError(f"{symbol} 无历史数据，请先运行 collector.py fetch {symbol}")
    if bench.empty:
        raise RuntimeError(f"基准 {benchmark} 无历史数据")

    # 对齐基准（只用共同交易日）
    merged = stock.merge(
        bench[["time", "close"]].rename(columns={"close": "bench_close"}),
        on="time", how="inner",
    ).reset_index(drop=True)
    if len(merged) < 60:
        raise RuntimeError(f"对齐后仅 {len(merged)} 个交易日，样本不足（需 ≥60）")

    # 计算条件信号（用 merged 的行情列，避免对齐错位）
    sig = fn(merged, params)
    sig = sig.fillna(False).astype(bool)

    # 事件发生的索引（排除最后 horizon 个，因为无法观察未来收益）
    idx = np.flatnonzero(sig.to_numpy())
    idx = idx[idx < len(merged) - horizon]

    # 计算每笔事件的 horizon 日收益与超额收益
    stock_ret, bench_ret, excess = [], [], []
    for i in idx:
        p0 = merged["close"].iloc[i]
        p1 = merged["close"].iloc[i + horizon]
        b0 = merged["bench_close"].iloc[i]
        b1 = merged["bench_close"].iloc[i + horizon]
        if not p0 or not b0:
            continue
        sr = p1 / p0 - 1
        br = b1 / b0 - 1
        stock_ret.append(sr)
        bench_ret.append(br)
        excess.append(sr - br)

    n = len(excess)
    if n == 0:
        return {
            "symbol": symbol, "condition": condition, "conditionDescription": desc,
            "params": params, "horizon": horizon, "benchmark": benchmark,
            "sampleSize": 0,
            "note": "该条件下没有可用事件样本（可能阈值过严或历史数据太短）",
        }

    ex = np.array(excess, dtype=float)
    mean_ex = float(np.mean(ex))
    std_ex = float(np.std(ex, ddof=1)) if n > 1 else 0.0
    se = std_ex / np.sqrt(n) if n > 1 and std_ex > 0 else None
    t_stat = float(mean_ex / se) if se else None
    win_rate = float(np.mean(ex > 0))

    # 简化显著性判断（|t| >= 2 视为在 5% 水平显著，大样本近似）
    significant = bool(t_stat is not None and abs(t_stat) >= 2.0)

    return {
        "symbol": symbol,
        "benchmark": benchmark,
        "condition": condition,
        "conditionDescription": desc,
        "params": params,
        "horizon": horizon,
        "sampleSize": n,
        "sampleRange": {
            "first": str(merged["time"].iloc[idx[0]]) if len(idx) else None,
            "last": str(merged["time"].iloc[idx[-1]]) if len(idx) else None,
        },
        "stats": {
            "meanStockReturn": round(float(np.mean(stock_ret)), 4),
            "meanBenchmarkReturn": round(float(np.mean(bench_ret)), 4),
            "meanExcessReturn": round(mean_ex, 4),
            "medianExcessReturn": round(float(np.median(ex)), 4),
            "stdExcessReturn": round(std_ex, 4),
            "tStat": None if t_stat is None else round(t_stat, 3),
            "winRate": round(win_rate, 4),
            "significant5pct": significant,
            "bestExcess": round(float(np.max(ex)), 4),
            "worstExcess": round(float(np.min(ex)), 4),
        },
        "interpretation": {
            "significant": significant,
            "text": (
                f"在 {n} 个历史事件样本中，事件后 {horizon} 日的平均超额收益为 {mean_ex*100:.2f}%，"
                f"胜率 {win_rate*100:.1f}%，t 统计量 {t_stat:.2f}，"
                + ("在 5% 水平上统计显著。" if significant else "未达到常用的 5% 显著性门槛。")
            ),
            "caveats": [
                "这是历史统计描述，不构成因果结论，也不保证未来重复。",
                "样本量较小时 t 检验不可靠；多重比较会推高假阳性概率。",
                "未控制市场状态、行业轮动、流动性等混杂因素。",
                "复权方式、事件判定阈值都会影响结果。",
            ],
        },
        "meta": {
            "timeframe": timeframe,
            "adjust": adjust,
            "dataRows": int(len(merged)),
            "dataSource": "local-storage",
        },
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Event Study")
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--condition", required=True, choices=list(CONDITIONS))
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--benchmark", default="IDX000300")
    ap.add_argument("--params", default="{}", help='JSON，如 \'{"n":20,"mult":1.5}\'')
    args = ap.parse_args()
    out = run_event_study(
        args.symbol, args.condition,
        params=json.loads(args.params), horizon=args.horizon, benchmark=args.benchmark,
    )
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
