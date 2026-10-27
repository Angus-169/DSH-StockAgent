"""
storage.py — Stock Lab 本地历史数据层

设计（ARCHITECTURE §4）：
  - 对外只暴露 load/save 接口，**不绑定具体存储格式**
  - 当前环境无 pyarrow/fastparquet，因此默认后端为 parquet 优先、回退 csv.gz
  - 将来装了 pyarrow 或迁移到 DuckDB，只需改本文件，调用方不变

目录结构（$DSH_STOCK_LAB_HOME/data/）：
  bars/<symbol>/<timeframe><adjust>.csv.gz    K线（按 symbol 分区）
  bars/<symbol>/<timeframe><adjust>.parquet   同上（若 pyarrow 可用）
  meta.db                                      采集元信息（时间戳/来源/行数）
"""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import pandas as pd

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------

def _home() -> Path:
    """数据根目录。

    优先级：
      1. DSH_STOCK_LAB_DATA  —— 显式指定（推荐，可指向工作区内）
      2. DSH_STOCK_LAB_HOME/data
      3. $DSH_HOME/stock-lab/data
      4. ~/.dsh/stock-lab/data

    注：DSH 沙箱允许写 profile 目录内部（插件运行时自己建的），但不允许
    在 ~/.dsh 下新建顶层目录，因此实际部署时建议用 DSH_STOCK_LAB_DATA
    指向工作区内的数据目录。
    """
    explicit = os.environ.get("DSH_STOCK_LAB_DATA")
    if explicit:
        return Path(explicit)
    home = os.environ.get("DSH_STOCK_LAB_HOME")
    if home:
        return Path(home) / "data"
    dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    return Path(dsh_home) / "stock-lab" / "data"


DATA_DIR = _home()
BARS_DIR = DATA_DIR / "bars"
META_DB = DATA_DIR / "meta.db"


def _maybe_parquet() -> bool:
    try:
        import pyarrow  # noqa: F401
        return True
    except Exception:
        try:
            import fastparquet  # noqa: F401
            return True
        except Exception:
            return False


HAS_PARQUET = _maybe_parquet()


def ensure_dirs() -> None:
    BARS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def connect_meta() -> sqlite3.Connection:
    ensure_dirs()
    con = sqlite3.connect(META_DB)
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS bars_meta (
            symbol TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            adjust TEXT NOT NULL,
            rows INTEGER NOT NULL,
            first_bar TEXT,
            last_bar TEXT,
            source TEXT,
            fetched_at TEXT NOT NULL,
            backend TEXT NOT NULL,
            PRIMARY KEY (symbol, timeframe, adjust)
        )
        """
    )
    con.commit()
    return con


# ---------------------------------------------------------------------------
# 路径解析
# ---------------------------------------------------------------------------

def bars_path(symbol: str, timeframe: str = "1d", adjust: str = "qfq") -> Path:
    safe = symbol.replace("/", "_").replace("\\", "_")
    ensure_dirs()
    base = BARS_DIR / safe
    base.mkdir(parents=True, exist_ok=True)
    ext = "parquet" if HAS_PARQUET else "csv.gz"
    return base / f"{timeframe}_{adjust}.{ext}"


# ---------------------------------------------------------------------------
# 读写
# ---------------------------------------------------------------------------

REQUIRED_COLS = ["time", "open", "high", "low", "close", "volume"]


def save_bars(
    symbol: str,
    df: pd.DataFrame,
    *,
    timeframe: str = "1d",
    adjust: str = "qfq",
    source: str = "unknown",
) -> dict:
    """保存（覆盖式合并）K线。按 time 去重，保留最新一次采集的值。"""
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"缺少必需列: {missing}")
    if df.empty:
        raise ValueError("不能保存空 DataFrame")

    out = df.copy()
    out["time"] = out["time"].astype(str)
    out = out.sort_values("time").drop_duplicates(subset=["time"], keep="last")

    # 合并已有数据（增量采集时保留历史）
    path = bars_path(symbol, timeframe, adjust)
    if path.exists():
        old = _read_any(path)
        if old is not None and not old.empty:
            out = pd.concat([old, out], ignore_index=True)
            out = out.sort_values("time").drop_duplicates(subset=["time"], keep="last")

    out = out.reset_index(drop=True)
    _write_any(path, out)

    meta = {
        "symbol": symbol,
        "timeframe": timeframe,
        "adjust": adjust,
        "rows": int(len(out)),
        "first_bar": str(out["time"].iloc[0]),
        "last_bar": str(out["time"].iloc[-1]),
        "source": source,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "backend": "parquet" if HAS_PARQUET else "csv.gz",
    }
    con = connect_meta()
    try:
        con.execute(
            """
            INSERT INTO bars_meta (symbol,timeframe,adjust,rows,first_bar,last_bar,source,fetched_at,backend)
            VALUES (:symbol,:timeframe,:adjust,:rows,:first_bar,:last_bar,:source,:fetched_at,:backend)
            ON CONFLICT(symbol,timeframe,adjust) DO UPDATE SET
                rows=excluded.rows, first_bar=excluded.first_bar, last_bar=excluded.last_bar,
                source=excluded.source, fetched_at=excluded.fetched_at, backend=excluded.backend
            """,
            meta,
        )
        con.commit()
    finally:
        con.close()
    return meta


def load_bars(
    symbol: str,
    *,
    timeframe: str = "1d",
    adjust: str = "qfq",
    start: str | None = None,
    end: str | None = None,
) -> pd.DataFrame:
    path = bars_path(symbol, timeframe, adjust)
    if not path.exists():
        return pd.DataFrame(columns=REQUIRED_COLS)
    df = _read_any(path)
    if df is None or df.empty:
        return pd.DataFrame(columns=REQUIRED_COLS)
    if start:
        df = df[df["time"] >= str(start)]
    if end:
        df = df[df["time"] <= str(end)]
    return df.reset_index(drop=True)


def list_bars_meta() -> list[dict]:
    con = connect_meta()
    try:
        rows = con.execute("SELECT * FROM bars_meta ORDER BY symbol").fetchall()
        cols = [d[0] for d in con.execute("SELECT * FROM bars_meta LIMIT 0").description]
    finally:
        con.close()
    return [dict(zip(cols, r)) for r in rows]


def _write_any(path: Path, df: pd.DataFrame) -> None:
    if path.suffix == ".parquet":
        df.to_parquet(path, index=False)
        return
    # csv.gz
    with gzip.open(path, "wt", encoding="utf-8", newline="") as f:
        df.to_csv(f, index=False)


def _read_any(path: Path) -> pd.DataFrame | None:
    try:
        if path.suffix == ".parquet":
            return pd.read_parquet(path)
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return pd.read_csv(f)
    except FileNotFoundError:
        return None


# ---------------------------------------------------------------------------
# 可复现性：数据版本指纹
# ---------------------------------------------------------------------------

def data_version(symbols: Iterable[str], timeframe: str = "1d", adjust: str = "qfq") -> str:
    """给一组标的的数据状态生成指纹，供 Research Note 记录"当时用的是哪版数据"。"""
    import hashlib

    h = hashlib.sha256()
    for s in sorted(symbols):
        p = bars_path(s, timeframe, adjust)
        h.update(s.encode())
        if p.exists():
            st = p.stat()
            h.update(f"{st.st_size}:{int(st.st_mtime)}".encode())
        else:
            h.update(b"missing")
    return h.hexdigest()[:16]


if __name__ == "__main__":
    print(json.dumps({
        "home": str(_home()),
        "data_dir": str(DATA_DIR),
        "has_parquet": HAS_PARQUET,
        "backend": "parquet" if HAS_PARQUET else "csv.gz",
    }, ensure_ascii=False, indent=2))
