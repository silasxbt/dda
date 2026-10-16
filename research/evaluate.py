"""Offline quote-risk experiment. Never connects to a chain or places orders."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

BASE = ["net", "gross", "impact", "latency", "size"]
PRESSURE = ["swapsPerSecond", "sameDirectionShare", "repeatShare", "concentration"]


def load(paths):
    import math
    rows, seen = [], set()
    for path in paths:
        for r in json.loads(Path(path).read_text())["rows"]:
            if r["episode"] in seen:
                continue
            if not all(isinstance(r.get(k), (int, float)) and math.isfinite(r[k]) for k in BASE + PRESSURE):
                continue
            if r.get("label") not in (0, 1) or r.get("eventEnd", 0) < r["at"] or r.get("labelAt", 0) < r["at"] + 5000:
                continue
            if r.get("market", "").startswith("跨链"):
                continue  # Asset-equivalence failures are not actionable training opportunities.
            seen.add(r["episode"])
            rows.append(r)
    return sorted(rows, key=lambda r: (r["at"], r["episode"]))


def gate(rows):
    days = len({datetime.fromtimestamp(r["at"] / 1000, timezone.utc).date() for r in rows})
    positive = sum(r["label"] for r in rows)
    return dict(eligible=days >= 7 and len(rows) >= 1000 and min(positive, len(rows) - positive) >= 100,
                days=days, events=len(rows), positive=positive, negative=len(rows) - positive)


def evaluate(rows):
    result = {"gate": gate(rows), "trained": False,
              "target": "五秒后报价净额下降或模拟亏损；不表示真实竞争者参与概率",
              "conclusion": "证据不足，不训练", "inputDigest": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()}
    if not result["gate"]["eligible"]:
        return result
    # Fixed features/hyperparameters; entire episodes are disjoint, with horizon embargo.
    b1, b2 = rows[int(len(rows) * .6)]["at"], rows[int(len(rows) * .8)]["at"]
    train = [r for r in rows if max(r["eventEnd"] + 15000, r["labelAt"]) < b1]
    valid = [r for r in rows if r["at"] >= b1 and max(r["eventEnd"] + 15000, r["labelAt"]) < b2]
    test = [r for r in rows if r["at"] >= b2]
    result["split"] = {"train": len(train), "validation": len(valid), "test": len(test), "purged": len(rows) - len(train) - len(valid) - len(test)}
    if any(len({r["label"] for r in part}) < 2 or len(part) < 50 for part in (train, valid, test)):
        result["conclusion"] = "时间切分后类别或样本不足，不训练"
        return result
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, roc_auc_score, log_loss
    import numpy as np
    models = []
    predictions = []
    for name, keys in [("传统特征", BASE), ("传统加竞争特征", BASE + PRESSURE)]:
        x = lambda part: [[r[k] for k in keys] for r in part]
        y = lambda part: [r["label"] for r in part]
        model = make_pipeline(StandardScaler(), LogisticRegression(C=1, max_iter=1000, random_state=0))
        model.fit(x(train), y(train))
        p = model.predict_proba(x(test))[:, 1]
        pv = model.predict_proba(x(valid))[:, 1]
        predictions.append(p)
        models.append({"name": name, "features": keys, "auc": roc_auc_score(y(test), p),
                       "brier": brier_score_loss(y(test), p), "logLoss": log_loss(y(test), p),
                       "validationBrier": brier_score_loss(y(valid), pv),
                       "coefficientsStandardized": dict(zip(keys, model[-1].coef_[0].tolist()))})
    # Paired bootstrap by UTC day, not by correlated quote row. Few days -> no CI.
    days = sorted({r["day"] for r in test})
    ci = None
    if len(days) >= 7:
        rng = np.random.default_rng(0)
        indices = {day: [i for i, r in enumerate(test) if r["day"] == day] for day in days}
        y = np.array([r["label"] for r in test])
        deltas = []
        for _ in range(1000):
            idx = np.concatenate([indices[d] for d in rng.choice(days, len(days), replace=True)])
            deltas.append(float(np.mean((predictions[1][idx] - y[idx]) ** 2 - (predictions[0][idx] - y[idx]) ** 2)))
        ci = np.quantile(deltas, [.025, .975]).tolist()
    result.update(trained=True, models=models, pairedDayBootstrapBrierDelta95=ci,
                  conclusion="实验模型已拟合；误差差异不等于交易盈利，仍需独立时间窗口验证",
                  limitation="跨会话重叠采集可能重复同一经济事件，合并前需人工排除；不输出实盘交易指令")
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("datasets", nargs="+")
    p.add_argument("--output", default="model-report.json")
    args = p.parse_args()
    result = evaluate(load(args.datasets))
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"trained": result["trained"], "gate": result["gate"], "output": args.output}, ensure_ascii=False))
