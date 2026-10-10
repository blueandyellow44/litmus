#!/usr/bin/env python3
"""Failure inventory for the Daily paper workflow (Max, 2026-09-22).

Step 1 of the run-failure method: before fixing any failed run, look at ALL of
them side by side. Downloads every Daily paper run log since --since (cached),
then prints one row per run: step durations, articles scored, clusterer
outcome, Story Ledger offered/eligible, model errors by class, and the SILENT
TAIL - minutes between a step's last log line and the timeout. A long silent
tail means the process was doing something that logs nothing (or hung), which
is a different bug from "slow".

Free: reads GitHub logs only, makes no model or database calls.

  python3 scripts/run-inventory.py --since 2026-09-01 [--cache DIR] [--all]
"""
import argparse, datetime as dt, json, os, re, subprocess, sys
from collections import Counter

def sh(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout

def ts(line):
    m = re.search(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d+Z", line)
    return dt.datetime.fromisoformat(m.group(1)) if m else None

def errclass(s):
    if "usage limits" in s: return "usage-limit"
    if "rate_limit" in s or " 429" in s: return "rate-limit"
    if "overloaded" in s or " 529" in s: return "overloaded"
    if "malformed" in s: return "malformed-output"
    if "max_tokens" in s: return "max-tokens"
    if "timed out" in s.lower() or "timeout" in s.lower(): return "timeout"
    return "other"

def payload(line):
    i = line.find('{"t"')
    try: return json.loads(line[i:]) if i >= 0 else {}
    except json.JSONDecodeError: return {}

def analyse(run, lines):
    steps = {}
    for l in lines:
        m = re.search(r"\[refresh\] (\d)/7", l)
        if m and m.group(1) not in steps: steps[m.group(1)] = ts(l)
    stamped = [t for t in map(ts, lines) if t]
    end = stamped[-1] if stamped else None
    def dur(a, b):
        A, B = steps.get(a), steps.get(b) or end
        return round((B - A).total_seconds() / 60, 1) if A and B else None
    timedout = any("has timed out after" in l for l in lines)
    # Last application log line (JSON logger) before the end: the silent tail.
    app = [ts(l) for l in lines if '{"t"' in l and ts(l)]
    tail = round((end - app[-1]).total_seconds() / 60, 1) if timedout and app else None
    sc = [payload(l) for l in lines if '"score cycle done"' in l]
    off = [payload(l) for l in lines if '"story ledger offered articles"' in l]
    crash = [l for l in lines if '"cluster cycle crashed"' in l]
    started = run["createdAt"]; updated = run["updatedAt"]
    wall = (dt.datetime.fromisoformat(updated[:19]) - dt.datetime.fromisoformat(started[:19])).total_seconds() / 60
    return {
        "id": run["databaseId"], "event": run["event"], "start": started[:16], "sha": run["headSha"][:7],
        "conclusion": run["conclusion"], "wall_min": round(wall, 1),
        "ingest": dur("2", "3"), "score": dur("3", "4"), "cluster": dur("4", "5"),
        "ledger": dur("5", "6") if any('"story ledger run start"' in l for l in lines) else None,
        "scored": sum(x.get("scored", 0) for x in sc), "score_failed": sum(x.get("failed", 0) for x in sc),
        "cluster_crash": errclass(crash[0]) if crash else "",
        "ledger_offered": f'{off[0].get("offeredCount", off[0].get("count"))}/{off[0].get("eligibleCount", "?")}' if off else "",
        "ledger_done": any('"story ledger run done"' in l for l in lines),
        "model_errors": dict(Counter(errclass(l) for l in lines if "model request failed" in l)),
        "timed_out": timedout, "silent_tail_min": tail,
        "deployed": any("Deployment complete" in l for l in lines),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-09-01")
    ap.add_argument("--cache", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "litmus-run-logs"))
    ap.add_argument("--all", action="store_true", help="print healthy runs too")
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    runs = json.loads(sh("gh", "run", "list", "--workflow", "Daily paper", "--limit", "200",
                         "--json", "databaseId,event,conclusion,createdAt,updatedAt,headSha"))
    runs = [r for r in runs if r["createdAt"] >= a.since and r["conclusion"]]
    rows = []
    for r in runs:
        path = os.path.join(a.cache, f'{r["databaseId"]}.log')
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            with open(path, "w") as f: f.write(sh("gh", "run", "view", str(r["databaseId"]), "--log"))
        rows.append(analyse(r, open(path, errors="replace").read().splitlines()))
    bad = lambda x: (x["conclusion"] != "success" or x["score_failed"] or x["cluster_crash"]
                     or x["ledger"] is not None or x["model_errors"] or not x["deployed"])
    shown = rows if a.all else [x for x in rows if bad(x)]
    print(f"{len(rows)} runs since {a.since}; {sum(bool(bad(x)) for x in rows)} failed or degraded\n")
    cols = ["id", "event", "start", "sha", "conclusion", "wall_min", "ingest", "score", "cluster", "ledger",
            "scored", "score_failed", "cluster_crash", "ledger_offered", "ledger_done", "model_errors",
            "timed_out", "silent_tail_min", "deployed"]
    print("| " + " | ".join(cols) + " |"); print("|" + "---|" * len(cols))
    for x in shown:
        print("| " + " | ".join("" if x[c] in (None, {}) else str(x[c]) for c in cols) + " |")

if __name__ == "__main__":
    sys.exit(main())
