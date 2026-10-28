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

def _pkg_root() -> Path:
    """包根目录（含 package.json / backend / src）。

    `<包根>/backend/storage/storage.py` → parents[0]=storage, [1]=backend, [2]=包根。
    """
    return Path(__file__).resolve().parents[2]


# 与 src/data-root.js 的 DATA_SUFFIXES 保持一致
_DATA_SUFFIXES = (".csv.gz", ".parquet")
# 最多扫描多少个 symbol 目录（防止海量空目录把解析拖慢；找到第一个就返回）
_SCAN_LIMIT = 200


def _has_data(d: Path) -> bool:
    """某个候选目录里是否**真的有** K 线数据。

    判据：`bars/<symbol>/` 下至少有一个 `*.csv.gz` / `*.parquet`。
    刻意**不**把「meta.db 存在」或「bars/ 目录存在」当成有数据——
    空库（schema 建好但 0 行、或只有空目录）会把真正的数据目录顶掉。
    这是实测踩过的坑：只读命令曾顺手建出空 meta.db，导致真库"消失"。
    """
    bars = d / "bars"
    try:
        names = sorted(p for p in bars.iterdir())[:_SCAN_LIMIT]
    except OSError:
        return False
    for sub in names:
        try:
            if not sub.is_dir():
                continue
            for f in sub.iterdir():
                if f.is_file() and f.name.endswith(_DATA_SUFFIXES):
                    return True
        except OSError:
            continue
    return False


def _home() -> Path:
    """数据根目录。

    解析顺序**必须与 `src/data-root.js` 的 `resolveDataRoot()` 完全同构**：

      1. DSH_STOCK_LAB_DATA        —— 显式指定 → 直接采用（即使目录还不存在）
      2. DSH_STOCK_LAB_HOME/data   —— 显式指定 → 直接采用（不再探测有没有数据）
      3. $DSH_HOME/stock-lab/data  —— 隐式候选：第一个"真的有 K 线数据"的
      4. <包根>/data               —— 都没有数据时取它（开发期默认）

    注：DSH 沙箱允许写 profile 目录内部（插件运行时自己建的），但不允许
    在 ~/.dsh 下新建顶层目录，因此实际部署时建议用 DSH_STOCK_LAB_DATA
    指向工作区内的数据目录。

    ⚠️ 第 3/4 步的"有数据"判据见 `_has_data()`：**空目录/空 meta.db 不算数据**。
    Python 侧曾经没有第 4 步（只有 Node 有），于是命令行和运行期会指向不同目录。
    """
    explicit = os.environ.get("DSH_STOCK_LAB_DATA")
    if explicit:
        return Path(explicit)
    home = os.environ.get("DSH_STOCK_LAB_HOME")
    if home:
        return Path(home) / "data"
    dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    candidates = [Path(dsh_home) / "stock-lab" / "data", _pkg_root() / "data"]
    for c in candidates:
        if _has_data(c):
            return c
    return candidates[-1]


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


def connect_meta(*, create: bool = True) -> sqlite3.Connection:
    """打开 meta.db。

    - `create=True`（默认，**写入方**用）：建目录、建表、可写。
    - `create=False`（**只读方**用）：**不建目录、不建表、不可写**（PRAGMA query_only）。
      meta.db 不存在时抛 FileNotFoundError——调用方应先判断，不要靠"打开时顺手建库"。

    为什么要有只读模式：只读命令一旦顺手建库/建目录，就会在磁盘上留下"看起来像库"的空目录，
    而空目录会被数据根解析当成候选，进而把真正的库顶掉（见 `_home()` / `_has_data()`）。
    """
    if not create:
        if not META_DB.exists():
            raise FileNotFoundError(str(META_DB))
        con = sqlite3.connect(str(META_DB))
        con.execute("PRAGMA query_only = ON")
        return con
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

def bars_path(symbol: str, timeframe: str = "1d", adjust: str = "qfq", *, create: bool = False) -> Path:
    """某个标的的 K 线文件路径。

    `create=False`（默认）**不创建任何目录**：只读路径（load / status / version）
    不应该因为"看一眼"就在磁盘上留下空目录——空目录会被别的逻辑当成"这里有数据"，
    进而把真正的数据根顶掉（见 `_home()` 与 `_has_data()` 的注释）。
    只有真正的写入方（`save_bars`）才传 `create=True`。
    """
    safe = symbol.replace("/", "_").replace("\\", "_")
    base = BARS_DIR / safe
    if create:
        ensure_dirs()
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
    path = bars_path(symbol, timeframe, adjust, create=True)
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
    """列出已落库的元信息。

    只读：没有 meta.db 就返回空；**不建目录、不建表、不改写文件**（用 `connect_meta(create=False)`）。
    空文件 / 损坏的 meta.db 也返回空而不抛错——只读查询不该因为坏文件而崩。
    """
    if not META_DB.exists():
        return []
    try:
        con = connect_meta(create=False)
    except (sqlite3.Error, OSError):
        return []
    try:
        try:
            rows = con.execute("SELECT * FROM bars_meta ORDER BY symbol").fetchall()
            cols = [d[0] for d in con.execute("SELECT * FROM bars_meta LIMIT 0").description]
        except sqlite3.Error:
            return []
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
