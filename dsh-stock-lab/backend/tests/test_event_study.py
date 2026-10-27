"""
test_event_study.py — Event Study 单元测试（合成数据，不依赖网络）

运行：python backend/tests/test_event_study.py
"""

import os
import shutil
import sys
import unittest
from pathlib import Path

_TMP = str(Path(__file__).resolve().parents[2] / ".test-data" / "quant")
shutil.rmtree(_TMP, ignore_errors=True)
Path(_TMP).mkdir(parents=True, exist_ok=True)
os.environ["DSH_STOCK_LAB_DATA"] = _TMP

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "storage"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "quant"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from storage import save_bars  # noqa: E402
from event_study import CONDITIONS, run_event_study  # noqa: E402


def synth(n=400, seed=42, trend=0.0005, vol=0.02, jump_at=None):
    """生成可控的合成行情：正常随机游走 + 在指定位置注入事件后超额。"""
    rng = np.random.default_rng(seed)
    rets = rng.normal(trend, vol, n)
    if jump_at is not None:
        # 在事件后 5 日注入正超额（用于验证检测能力）
        for i in jump_at:
            if i + 5 < n:
                rets[i + 1:i + 6] += 0.03
    prices = 100 * np.cumprod(1 + rets)
    times = pd.date_range("2024-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
    volume = (rng.uniform(0.8e6, 1.2e6, n)).astype(float)
    return pd.DataFrame({
        "time": times,
        "open": prices * 0.995,
        "high": prices * 1.01,
        "low": prices * 0.99,
        "close": prices,
        "volume": volume,
    })


class EventStudyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 基准：平稳
        save_bars("IDX000300", synth(400, seed=1, trend=0.0003, vol=0.01), source="synth")

    def _save(self, sym, df):
        save_bars(sym, df, source="synth")

    def test_conditions_registered(self):
        for k in ["volume_spike", "breakout", "drawdown", "ma_cross", "big_move"]:
            self.assertIn(k, CONDITIONS)
            self.assertEqual(len(CONDITIONS[k]), 2)

    def test_volume_spike_finds_events(self):
        df = synth(400, seed=2)
        # 人为制造 8 个放量日
        for i in [50, 100, 150, 200, 250, 300, 330, 360]:
            df.loc[i, "volume"] = df["volume"].median() * 3
        self._save("SH000001", df)
        r = run_event_study("SH000001", "volume_spike", horizon=5)
        self.assertGreaterEqual(r["sampleSize"], 5, f"应检出放量事件，实际 {r['sampleSize']}")
        self.assertIn("stats", r)
        self.assertIn("interpretation", r)
        self.assertFalse(r["stats"]["significant5pct"])

    def test_injected_excess_is_detected(self):
        """注入 5 日 +3% 超额，应使均值明显偏正。"""
        df = synth(400, seed=3, jump_at=[60, 100, 140, 180, 220, 260, 300])
        for i in [60, 100, 140, 180, 220, 260, 300]:
            df.loc[i, "volume"] = df["volume"].median() * 3
        self._save("SH000002", df)
        r = run_event_study("SH000002", "volume_spike", horizon=5)
        self.assertGreater(r["sampleSize"], 0)
        self.assertGreater(r["stats"]["meanExcessReturn"], 0, "注入正超额后均值应为正")

    def test_no_future_bias_events_near_end_excluded(self):
        """最后 horizon 根不能作为事件（否则无法观察未来收益）。"""
        df = synth(300, seed=4)
        df.loc[298, "volume"] = df["volume"].median() * 10  # 倒数第二天放量
        self._save("SH000003", df)
        r = run_event_study("SH000003", "volume_spike", horizon=5)
        # 该事件在末尾，应被排除
        if r["sampleSize"] > 0:
            self.assertLess(r["sampleRange"]["last"], df["time"].iloc[-1])

    def test_insufficient_data_raises(self):
        df = synth(30, seed=5)
        self._save("SH000004", df)
        with self.assertRaises(RuntimeError):
            run_event_study("SH000004", "volume_spike", horizon=5)

    def test_missing_symbol_raises(self):
        with self.assertRaises(RuntimeError) as ctx:
            run_event_study("SH999998", "volume_spike")
        self.assertIn("无历史数据", str(ctx.exception))

    def test_unknown_condition_raises(self):
        df = synth(200, seed=6)
        self._save("SH000005", df)
        with self.assertRaises(ValueError):
            run_event_study("SH000005", "not_a_condition")

    def test_stats_fields_present(self):
        df = synth(400, seed=7)
        for i in [80, 120, 160, 200, 240, 280]:
            df.loc[i, "volume"] = df["volume"].median() * 3
        self._save("SH000006", df)
        r = run_event_study("SH000006", "volume_spike", horizon=5)
        st = r["stats"]
        for k in ["meanStockReturn", "meanBenchmarkReturn", "meanExcessReturn",
                  "medianExcessReturn", "stdExcessReturn", "tStat", "winRate",
                  "significant5pct"]:
            self.assertIn(k, st)
        self.assertGreaterEqual(st["winRate"], 0.0)
        self.assertLessEqual(st["winRate"], 1.0)
        # 必须带因果免责
        self.assertTrue(any("因果" in c for c in r["interpretation"]["caveats"]))

    def test_horizon_matters(self):
        df = synth(400, seed=8)
        for i in range(50, 350, 25):
            df.loc[i, "volume"] = df["volume"].median() * 3
        self._save("SH000007", df)
        r1 = run_event_study("SH000007", "volume_spike", horizon=1)
        r5 = run_event_study("SH000007", "volume_spike", horizon=5)
        self.assertEqual(r1["horizon"], 1)
        self.assertEqual(r5["horizon"], 5)
        self.assertGreater(r5["sampleSize"], 0)


if __name__ == "__main__":
    print(f"临时数据目录: {_TMP}")
    unittest.main(verbosity=2)
