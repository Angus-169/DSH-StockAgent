"""
backtest_storage.py — Python 侧存储层测试

运行：
  python backend/tests/test_storage.py
"""

import gzip
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

# 必须在 import storage 之前设置。
# 注意：不要用系统 temp 目录——DSH 沙箱对 Temp 写入受限（WinError 5），
# 因此测试数据放在项目内的 .test-data/（已 gitignore）。
_TMP = str(Path(__file__).resolve().parents[2] / ".test-data" / "storage")
shutil.rmtree(_TMP, ignore_errors=True)
Path(_TMP).mkdir(parents=True, exist_ok=True)
os.environ["DSH_STOCK_LAB_DATA"] = _TMP

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "storage"))

import pandas as pd  # noqa: E402

import storage  # noqa: E402  （测 _home / _has_data / _pkg_root 这些模块级函数）
from storage import (  # noqa: E402
    HAS_PARQUET, bars_path, data_version, list_bars_meta, load_bars, save_bars,
)


def make_df(n=5, start="2026-01-01", price=100.0):
    times = pd.date_range(start, periods=n, freq="D").strftime("%Y-%m-%d").tolist()
    return pd.DataFrame({
        "time": times,
        "open": [price + i for i in range(n)],
        "high": [price + i + 2 for i in range(n)],
        "low": [price + i - 2 for i in range(n)],
        "close": [price + i + 1 for i in range(n)],
        "volume": [1000 * (i + 1) for i in range(n)],
    })


class StorageTest(unittest.TestCase):
    def setUp(self):
        # 每个测试用独立 symbol，避免互相影响
        self.sym = "SH" + str(abs(hash(self._testMethodName)) % 900000 + 100000)

    def test_backend_detected(self):
        print(f"    backend = {'parquet' if HAS_PARQUET else 'csv.gz'}")
        self.assertIsInstance(HAS_PARQUET, bool)

    def test_save_and_load_roundtrip(self):
        df = make_df(5)
        meta = save_bars(self.sym, df, source="test")
        self.assertEqual(meta["rows"], 5)
        self.assertEqual(meta["symbol"], self.sym)
        self.assertEqual(meta["first_bar"], "2026-01-01")
        self.assertEqual(meta["last_bar"], "2026-01-05")

        got = load_bars(self.sym)
        self.assertEqual(len(got), 5)
        self.assertListEqual(
            ["time", "open", "high", "low", "close", "volume"],
            [c for c in got.columns if c in
             ["time", "open", "high", "low", "close", "volume"]],
        )
        self.assertAlmostEqual(float(got["close"].iloc[0]), 101.0)

    def test_incremental_merge_dedups(self):
        save_bars(self.sym, make_df(5, start="2026-01-01"))
        # 再存一份重叠 2 天 + 新增 2 天
        save_bars(self.sym, make_df(4, start="2026-01-04", price=200.0))
        got = load_bars(self.sym)
        # 1/1..1/5 共 5 天，加上 1/6,1/7 共 7 天；1/4,1/5 应以新值覆盖
        self.assertEqual(len(got), 7)
        self.assertEqual(got["time"].tolist(), sorted(got["time"].tolist()))
        row = got[got["time"] == "2026-01-04"].iloc[0]
        self.assertAlmostEqual(float(row["close"]), 201.0)  # 新批次的值

    def test_date_range_filter(self):
        save_bars(self.sym, make_df(10, start="2026-01-01"))
        got = load_bars(self.sym, start="2026-01-03", end="2026-01-06")
        self.assertEqual(len(got), 4)
        self.assertEqual(got["time"].iloc[0], "2026-01-03")
        self.assertEqual(got["time"].iloc[-1], "2026-01-06")

    def test_missing_symbol_returns_empty(self):
        got = load_bars("SZ999999")
        self.assertTrue(got.empty)
        self.assertIn("time", got.columns)

    def test_rejects_missing_columns(self):
        bad = pd.DataFrame({"time": ["2026-01-01"], "open": [1.0]})
        with self.assertRaises(ValueError):
            save_bars(self.sym, bad)

    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            save_bars(self.sym, make_df(0))

    def test_meta_listing(self):
        save_bars(self.sym, make_df(3), source="unit")
        metas = list_bars_meta()
        hit = [m for m in metas if m["symbol"] == self.sym]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0]["source"], "unit")
        self.assertEqual(hit[0]["rows"], 3)

    def test_data_version_stable_and_sensitive(self):
        save_bars(self.sym, make_df(3))
        v1 = data_version([self.sym])
        v2 = data_version([self.sym])
        self.assertEqual(v1, v2, "同一状态应产生同一指纹")
        self.assertEqual(len(v1), 16)
        # 追加数据后指纹必须改变
        save_bars(self.sym, make_df(6, start="2026-02-01"))
        v3 = data_version([self.sym])
        self.assertNotEqual(v1, v3, "数据变化后指纹应改变")

    def test_path_partitioned_by_symbol(self):
        p = bars_path(self.sym)
        self.assertIn(self.sym, str(p))
        # 只读路径**不建目录**（回归：曾经一读就 mkdir，留下空目录 → 空库顶掉真库）
        self.assertFalse(p.parent.exists(), "bars_path() 默认不应创建目录")
        save_bars(self.sym, make_df(2))
        self.assertTrue(p.parent.exists(), "save_bars 应创建目录")


class DataRootResolutionTest(unittest.TestCase):
    """数据根目录解析 —— 必须与 src/data-root.js 的 resolveDataRoot() 同构。

    这些用例锁住两条真实缺陷：
      1. Python 侧曾经**没有**「包内 data」兜底（只有 Node 有）→ 命令行与运行期指向不同目录
      2. 「有数据」曾经只看 meta.db / bars 目录是否存在 → 空库把真库顶掉
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="stocklab-root-", dir=_TMP))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @contextmanager
    def _env(self, **kw):
        keys = ("DSH_STOCK_LAB_DATA", "DSH_STOCK_LAB_HOME", "DSH_HOME")
        saved = {k: os.environ.get(k) for k in keys}
        try:
            for k in keys:
                os.environ.pop(k, None)
            for k, v in kw.items():
                if v is not None:
                    os.environ[k] = str(v)
            yield
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def _make_empty_library(self, data_dir: Path):
        """造一个"看起来像库、其实没有数据"的目录：建了 schema 的 meta.db + 空符号目录。"""
        (data_dir / "bars" / "SH600000").mkdir(parents=True, exist_ok=True)
        data_dir.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(data_dir / "meta.db")
        con.execute(
            "CREATE TABLE IF NOT EXISTS bars_meta (symbol TEXT, timeframe TEXT, adjust TEXT, "
            "rows INTEGER, first_bar TEXT, last_bar TEXT, source TEXT, fetched_at TEXT, backend TEXT)"
        )
        con.commit()
        con.close()

    def _make_real_library(self, data_dir: Path):
        d = data_dir / "bars" / "SH600000"
        d.mkdir(parents=True, exist_ok=True)
        with gzip.open(d / "1d_qfq.csv.gz", "wt", encoding="utf-8") as f:
            f.write("time,open,high,low,close,volume\n2026-01-05,1,2,0.5,1.5,100\n")

    def test_explicit_data_wins_even_if_missing(self):
        missing = self.tmp / "nope"
        with self._env(DSH_STOCK_LAB_DATA=missing, DSH_HOME=self.tmp / "dsh"):
            self.assertEqual(storage._home(), missing)

    def test_explicit_home_wins_even_if_empty(self):
        with self._env(DSH_STOCK_LAB_HOME=self.tmp / "home", DSH_HOME=self.tmp / "dsh"):
            self.assertEqual(storage._home(), self.tmp / "home" / "data")

    def test_empty_library_is_not_data(self):
        """空 meta.db + 空 bars 目录 → 不算"有数据"，不能顶掉包内真库。"""
        empty = self.tmp / "dsh" / "stock-lab" / "data"
        self._make_empty_library(empty)
        self.assertFalse(storage._has_data(empty))
        with self._env(DSH_HOME=self.tmp / "dsh"):
            self.assertEqual(storage._home(), storage._pkg_root() / "data")

    def test_real_bars_file_counts_as_data(self):
        real = self.tmp / "dsh" / "stock-lab" / "data"
        self._make_real_library(real)
        self.assertTrue(storage._has_data(real))
        with self._env(DSH_HOME=self.tmp / "dsh"):
            self.assertEqual(storage._home(), real)

    def test_meta_db_alone_is_not_data(self):
        """只有 meta.db（没有任何 K 线文件）不算数据——这是只读命令曾经留下的空库形态。"""
        d = self.tmp / "dsh" / "stock-lab" / "data"
        self._make_empty_library(d)
        self.assertFalse(storage._has_data(d))

    def test_status_with_meta_but_no_bars_does_not_create_bars(self):
        """meta.db 存在、bars/ 不存在：只读 status 不得创建 bars/，也不得改写 meta.db。

        这是"只读边界"的最后一个缺口：`list_bars_meta()` 曾经在 meta.db 存在时
        仍走 `connect_meta()`（会 ensure_dirs + CREATE TABLE），把空库悄悄补齐成"像样的库"。
        """
        d = self.tmp / "dsh" / "stock-lab" / "data"
        d.mkdir(parents=True)
        con = sqlite3.connect(d / "meta.db")
        con.execute(
            "CREATE TABLE bars_meta (symbol TEXT, timeframe TEXT, adjust TEXT, rows INTEGER, "
            "first_bar TEXT, last_bar TEXT, source TEXT, fetched_at TEXT, backend TEXT)"
        )
        con.commit()
        con.close()
        before = (d / "meta.db").stat().st_size
        saved = (storage.DATA_DIR, storage.BARS_DIR, storage.META_DB)
        try:
            storage.DATA_DIR, storage.BARS_DIR, storage.META_DB = d, d / "bars", d / "meta.db"
            with self._env(DSH_HOME=self.tmp / "dsh"):
                self.assertEqual(list_bars_meta(), [])
            self.assertFalse((d / "bars").exists(), "只读调用不应创建 bars 目录")
            self.assertEqual((d / "meta.db").stat().st_size, before, "只读调用不应改写 meta.db")
        finally:
            storage.DATA_DIR, storage.BARS_DIR, storage.META_DB = saved

    def test_status_with_zero_byte_meta_returns_empty(self):
        """0 字节 meta.db（最坏形态）：返回空、不抛错，也不把它写成 12KB。"""
        d = self.tmp / "dsh" / "stock-lab" / "data"
        d.mkdir(parents=True)
        (d / "meta.db").write_bytes(b"")
        saved = (storage.DATA_DIR, storage.BARS_DIR, storage.META_DB)
        try:
            storage.DATA_DIR, storage.BARS_DIR, storage.META_DB = d, d / "bars", d / "meta.db"
            with self._env(DSH_HOME=self.tmp / "dsh"):
                self.assertEqual(list_bars_meta(), [])
            self.assertEqual((d / "meta.db").stat().st_size, 0, "只读查询不应改写空文件")
        finally:
            storage.DATA_DIR, storage.BARS_DIR, storage.META_DB = saved

    def test_readonly_calls_do_not_create_dirs(self):
        """status/version 这类只读路径不得在磁盘上留下空目录或空库。"""
        dsh = self.tmp / "dsh"
        saved = (storage.DATA_DIR, storage.BARS_DIR, storage.META_DB)
        try:
            storage.DATA_DIR = dsh / "stock-lab" / "data"
            storage.BARS_DIR = storage.DATA_DIR / "bars"
            storage.META_DB = storage.DATA_DIR / "meta.db"
            with self._env(DSH_HOME=dsh):
                self.assertEqual(list_bars_meta(), [])
                bars_path("SH600000")
                data_version(["SH600000"])
                self.assertFalse(dsh.exists(), "只读调用不应创建任何目录")
        finally:
            storage.DATA_DIR, storage.BARS_DIR, storage.META_DB = saved


if __name__ == "__main__":
    print(f"临时数据目录: {_TMP}")
    unittest.main(verbosity=2)
