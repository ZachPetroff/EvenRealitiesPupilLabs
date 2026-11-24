"""Plot G2 target positions against Neon gaze fixations.

usage: python plot_calibration.py <neon_recording_dir> <session>_gaze.csv
Writes <session>_calibration.png next to the gaze csv.
"""
import sys
from pathlib import Path
import cv2
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

REC = Path(sys.argv[1])
GAZE_CSV = Path(sys.argv[2])
OUT = GAZE_CSV.with_name(GAZE_CSV.stem.removesuffix("_gaze") + "_calibration.png")
DISPLAY_W, DISPLAY_H = 576, 288

df = pd.read_csv(GAZE_CSV)
inl = df[df["inlier"]]
A = np.c_[inl[["x", "y"]].to_numpy(float), np.ones(len(inl))]
M, *_ = np.linalg.lstsq(A, inl[["fix_x", "fix_y"]].to_numpy(float), rcond=None)
tgt = np.c_[df[["x", "y"]].to_numpy(float), np.ones(len(df))] @ M
corners = np.array([[0, 0, 1], [DISPLAY_W, 0, 1], [DISPLAY_W, DISPLAY_H, 1], [0, DISPLAY_H, 1], [0, 0, 1]]) @ M

# background: scene frame at the first target onset
frame_t = np.fromfile(REC / "Neon Scene Camera v1 ps1.time", "<i8")
cap = cv2.VideoCapture(str(REC / "Neon Scene Camera v1 ps1.mp4"))
for _ in range(int(np.searchsorted(frame_t, df["onset_ns"].min()))):
    cap.grab()
ok, img = cap.read()

responded = df["fix_x"].notna()
fig, (a0, a1) = plt.subplots(1, 2, figsize=(14, 5.5), gridspec_kw={"width_ratios": [1.6, 1]})

a0.imshow(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
a0.plot(corners[:, 0], corners[:, 1], color="white", lw=1, label="G2 display")
for i, r in df[df.inlier].iterrows():
    a0.plot([tgt[i, 0], r.fix_x], [tgt[i, 1], r.fix_y], color="white", lw=0.8, alpha=0.7)
a0.scatter(tgt[:, 0], tgt[:, 1], marker="+", s=120, c="lime", label="target")
a0.scatter(df.loc[df.inlier, "fix_x"], df.loc[df.inlier, "fix_y"], s=30, c="red", label="fixation (fit)")
a0.scatter(df.loc[responded & ~df.inlier, "fix_x"], df.loc[responded & ~df.inlier, "fix_y"],
           s=30, facecolors="none", edgecolors="orange", label="fixation (outlier)")
pad = 120
a0.set_xlim(corners[:, 0].min() - pad, corners[:, 0].max() + pad)
a0.set_ylim(corners[:, 1].max() + pad, corners[:, 1].min() - pad)
a0.set_title(f"Targets vs gaze in scene camera (median error {df.loc[df.inlier, 'resid_px'].median():.0f} px)")
a0.legend(loc="lower right", fontsize=8)
a0.axis("off")

colors = np.where(df.inlier, "tab:red", np.where(responded, "tab:orange", "lightgrey"))
a1.bar(df.trial, df.latency_ms.fillna(0), color=colors)
for _, r in df[~df.latency_ms.notna()].iterrows():
    a1.text(r.trial, 5, "no saccade", ha="center", va="bottom", rotation=90, fontsize=7, color="grey")
a1.set_xlabel("trial")
a1.set_ylabel("saccade latency (ms, uncorrected clocks)")
a1.set_title("Saccade latency per trial (red = in fit, orange = outlier)")
a1.set_xticks(df.trial)

fig.tight_layout()
fig.savefig(OUT, dpi=120)
print("saved", OUT)
