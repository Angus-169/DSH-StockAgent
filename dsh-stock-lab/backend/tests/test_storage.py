"""
backtest_storage.py — Python 侧存储层测试

运行：
  python backend/tests/test_storage.py
"""

import os
import shutil
import sys
import tempfile
import unittest
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
        self.assertTrue(p.parent.exists())


if __name__ == "__main__":
    print(f"临时数据目录: {_TMP}")
    unittest.main(verbosity=2)
