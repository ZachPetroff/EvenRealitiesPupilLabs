"""Render the Neon scene video with G2 targets and gaze drawn on top.

usage: python make_overlay_video.py <neon_recording_dir> <session>_gaze.csv <out.mp4> [start_frame] [end_frame]
"""
import sys, subprocess
from pathlib import Path
import cv2
import numpy as np
import pandas as pd

REC = Path(sys.argv[1])
TRIALS_GAZE = Path(sys.argv[2])  # *_gaze.csv from analyze_neon_g2.py
OUT = Path(sys.argv[3])
START = int(sys.argv[4]) if len(sys.argv) > 4 else 0
END = int(sys.argv[5]) if len(sys.argv) > 5 else None
TARGET_W, TARGET_H = 32, 32
DISPLAY_W, DISPLAY_H = 576, 288

df = pd.read_csv(TRIALS_GAZE)
inl = df[df["inlier"]]
A = np.c_[inl[["x", "y"]].to_numpy(float), np.ones(len(inl))]
M, *_ = np.linalg.lstsq(A, inl[["fix_x", "fix_y"]].to_numpy(float), rcond=None)
to_scene = lambda x, y: tuple(int(round(v)) for v in np.array([x, y, 1.0]) @ M)

frame_t = np.fromfile(REC / "Neon Scene Camera v1 ps1.time", "<i8")
gaze = np.fromfile(REC / "gaze ps1.raw", "<f4").reshape(-1, 2)
gaze_t = np.fromfile(REC / "gaze ps1.time", "<i8")

cap = cv2.VideoCapture(str(REC / "Neon Scene Camera v1 ps1.mp4"))
for _ in range(START):  # grab instead of seek, for exact frame/timestamp match
    cap.grab()
w, h = int(cap.get(3)), int(cap.get(4))
fps = cap.get(5)
enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                        "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-", "-c:v", "libx264",
                        "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", str(OUT)],
                       stdin=subprocess.PIPE)

display_box = (to_scene(0, 0), to_scene(DISPLAY_W, DISPLAY_H))
for t in frame_t[START:END]:
    ok, img = cap.read()
    if not ok:
        break
    cv2.rectangle(img, *display_box, (90, 90, 90), 1)
    for _, r in df[(df.onset_ns <= t) & (t < df.offset_ns)].iterrows():
        # the fit maps (x, y) to where gaze lands on the "+", so centre the marker there
        c = to_scene(r.x, r.y)
        hw = int(round(TARGET_W / 2 * M[0, 0]))
        hh = int(round(TARGET_H / 2 * M[1, 1]))
        p0, p1 = (c[0] - hw, c[1] - hh), (c[0] + hw, c[1] + hh)
        cv2.rectangle(img, p0, p1, (0, 255, 0), 2)
        cv2.drawMarker(img, c, (0, 255, 0), cv2.MARKER_CROSS, 16, 2)
        cv2.putText(img, f"trial {int(r.trial)}", (p0[0], p0[1] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
    j = np.searchsorted(gaze_t, t)
    if 0 < j < len(gaze_t) and abs(gaze_t[j] - t) < 20e6:
        cv2.circle(img, (int(gaze[j, 0]), int(gaze[j, 1])), 14, (0, 0, 255), 2)
    cv2.putText(img, f"{(t - frame_t[0]) / 1e9:6.2f} s", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    enc.stdin.write(img.tobytes())

enc.stdin.close()
enc.wait()
print("saved", OUT)
