"""Match G2 calibration trials to a Neon recording.

usage: python analyze_neon_g2.py <neon_recording_dir> [trials_csv]
If trials_csv is omitted, the session in ../data that overlaps the recording is used.
"""
import sys, json
from pathlib import Path
import numpy as np
import pandas as pd

REC = Path(sys.argv[1])
DATA_DIR = Path(__file__).resolve().parents[1] / "data"

if len(sys.argv) > 2:
    TRIALS = Path(sys.argv[2])
else:
    info = json.loads((REC / "info.json").read_text())
    rec_start, rec_end = info["start_time"], info["start_time"] + info["duration"]
    matches = []
    for f in sorted(DATA_DIR.glob("*.csv")):
        if f.stem.endswith("_gaze"):
            continue
        t = pd.to_datetime(pd.read_csv(f)["onsetRequestISO"]).astype("int64")
        if len(t) and rec_start <= t.min() and t.max() <= rec_end:
            matches.append(f)
    if len(matches) != 1:
        sys.exit(f"expected 1 session inside the recording, found {len(matches)}: {[m.name for m in matches]}")
    TRIALS = matches[0]
    print("session:", TRIALS.name)
OUT = TRIALS.with_name(TRIALS.stem + "_gaze.csv")

ev = np.dtype([("type", "<i4"), ("start", "<i8"), ("end", "<i8"),
               ("sx", "<f4"), ("sy", "<f4"), ("ex", "<f4"), ("ey", "<f4"),
               ("mx", "<f4"), ("my", "<f4"), ("amp_px", "<f4"), ("amp_deg", "<f4"),
               ("mean_vel", "<f4"), ("max_vel", "<f4")])
events = np.fromfile(REC / "fixations ps1.raw", ev)
sacc = events[events["type"] == 0]
fix = events[events["type"] == 1]

df = pd.read_csv(TRIALS)
req_ns = pd.to_datetime(df["onsetRequestISO"]).astype("int64").to_numpy()
df["onset_ns"] = req_ns + ((df["onsetAckMs"] - df["onsetRequestMs"]) * 1e6).astype("int64")
df["offset_ns"] = req_ns + ((df["offsetAckMs"] - df["onsetRequestMs"]) * 1e6).astype("int64")

rows = []
for _, r in df.iterrows():
    # response: longest fixation while the target is shown (skips undershoots and late starts)
    f = fix[(fix["end"] > r.onset_ns) & (fix["start"] < r.offset_ns) & (fix["start"] >= r.onset_ns)]
    f = f[np.argmax(np.minimum(f["end"], r.offset_ns) - f["start"])] if len(f) else None
    rows.append(dict(fix_start_ms=(f["start"] - r.onset_ns) / 1e6 if f is not None else np.nan,
                     fix_x=f["mx"] if f is not None else np.nan,
                     fix_y=f["my"] if f is not None else np.nan))
df = pd.concat([df, pd.DataFrame(rows)], axis=1)

ok = df[["fix_x", "fix_y"]].notna().all(axis=1)
A_all = np.c_[df[["x", "y"]].to_numpy(float), np.ones(len(df))]
B_all = df[["fix_x", "fix_y"]].to_numpy(float)
for _ in range(2):  # fit, drop points > 3x median residual, refit
    M, *_ = np.linalg.lstsq(A_all[ok], B_all[ok], rcond=None)
    resid = np.linalg.norm(B_all - A_all @ M, axis=1)
    ok = ok & (resid < 3 * np.nanmedian(resid[ok]))
df["resid_px"] = resid
df["inlier"] = ok
A, B = A_all[ok], B_all[ok]
pred = A @ M
r2 = 1 - ((B - pred) ** 2).sum(0) / ((B - B.mean(0)) ** 2).sum(0)

# latency: first saccade after onset that moves gaze at least halfway to the fitted target
# (clocks are unsynced, so no minimum latency is applied)
tgt = A_all @ M
lat, amp = [], []
for i, r in df.iterrows():
    s = sacc[(sacc["start"] >= r.onset_ns) & (sacc["start"] < r.offset_ns)]
    d0 = np.hypot(s["sx"] - tgt[i, 0], s["sy"] - tgt[i, 1])
    d1 = np.hypot(s["ex"] - tgt[i, 0], s["ey"] - tgt[i, 1])
    s = s[d1 < 0.5 * d0]
    lat.append((s[0]["start"] - r.onset_ns) / 1e6 if len(s) else np.nan)
    amp.append(s[0]["amp_deg"] if len(s) else np.nan)
df["latency_ms"], df["amp_deg"] = lat, amp

df.to_csv(OUT, index=False)
print(f"trials {len(df)}, with saccade {df.latency_ms.notna().sum()}, fit inliers {ok.sum()}")
print("latency ms: median %.0f, range %.0f-%.0f" % (df.latency_ms.median(), df.latency_ms.min(), df.latency_ms.max()))
print("affine target->scene gaze R2 x=%.2f y=%.2f, median resid %.0f px" % (r2[0], r2[1], df.resid_px.median()))
print("affine:\n", M.T.round(3))
print(df[["trial", "x", "y", "latency_ms", "amp_deg", "fix_start_ms", "fix_x", "fix_y", "resid_px"]].round(1).to_string(index=False))
print("saved", OUT)
