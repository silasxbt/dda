import unittest
from evaluate import evaluate, gate


class Gates(unittest.TestCase):
    def test_insufficient_data_never_trains(self):
        self.assertFalse(evaluate([])["trained"])
        rows = [{"at": 1792000000000 + i * 86400000, "label": i % 2} for i in range(7)]
        self.assertFalse(gate(rows)["eligible"])

    def test_event_count_alone_is_insufficient(self):
        self.assertFalse(gate([{"at": 1792000000000, "label": i % 2} for i in range(1200)])["eligible"])
        self.assertFalse(gate([{"at": 1792000000000 + i * 864000, "label": 1} for i in range(1200)])["eligible"])

    def test_offline_pipeline_uses_disjoint_time_windows(self):
        from datetime import datetime, timezone
        rows = []
        for i in range(1200):
            at = 1792000000000 + i * 3600000
            label = i % 2
            rows.append(dict(id=str(i), episode=str(i), at=at, eventEnd=at, labelAt=at+5000,
                             day=datetime.fromtimestamp(at/1000, timezone.utc).date().isoformat(),
                             market="bsc USDC/USDT", label=label, net=.1, gross=.2, impact=3,
                             latency=100, size=100, swapsPerSecond=label, sameDirectionShare=label,
                             repeatShare=0, concentration=0))
        result = evaluate(rows)
        self.assertTrue(result["trained"])
        self.assertEqual(result["split"]["test"], 240)
        self.assertLess(result["models"][1]["brier"], result["models"][0]["brier"])


if __name__ == "__main__":
    unittest.main()
