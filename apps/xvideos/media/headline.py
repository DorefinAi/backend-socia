"""Screen reading for step 4 (README §4.2): the headline bar lines and the other screen text of one clip.

Moved in from the trial script x_headline.py (trials 4-5, 27 Nov 2026), screen part only. The day's programme filler
(fixes A and C) and the model's headline are the worker's (src/headline/), which sees the day's other clips.

Per clip
  1. ffmpeg: one frame every 3 s over the first 75 s, scaled to 1280 wide.
  2. Frames grouped by the picture of the red headline bar (one group per bar line).
  3. PaddleOCR 3.x on the GPU, fixed screen regions only: the bar in every frame, the place tag and the right panel once
     per group.
  4. Bar lines: the bar's words joined left to right, logo bits dropped, the most typical reading of each line kept
     (vote), half-drawn and repeated lines removed.

    python -I headline.py --check [clip.mp4]     loads the GPU models (as the service does); reads one clip when given
"""

from __future__ import annotations

import difflib
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

# Beside the backend and frontend repos: digital\x-requirements (media -> xvideos -> apps -> backend -> digital)
REQUIREMENTS = Path(os.environ.get("XVIDEOS_REQUIREMENTS") or Path(__file__).resolve().parents[4] / "x-requirements")
MODELS = REQUIREMENTS / "models"

os.environ.setdefault("FLAGS_allocator_strategy", "auto_growth")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "huggingface")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
# PaddleOCR's models live in x-requirements\models\paddle\official_models (setup_models.py)
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(MODELS / "paddle"))

from PIL import Image, ImageChops, ImageStat  # noqa: E402

HEAD_S, STEP_S = 75, 3                       # first 75 s, a frame every 3 s
BAR_DIFF = 6.0                               # bar picture difference (0-255) that counts as a new line
# Boxes as fractions of a 16:9 frame (x0, y0, x1, y1), calibrated 27 Nov 2026 on the First India template.
BAR_HASH_BOX = (0.05, 0.065, 0.82, 0.155)    # bar text only: no logo, no animated flare above the bar
ROI = {"bar": (0.00, 0.00, 0.85, 0.16),      # red headline bar, without the logo
       "slug": (0.00, 0.14, 0.45, 0.32),     # yellow place tag
       "right": (0.45, 0.19, 1.00, 0.77)}    # BREAKING box, key points, name strips (starts below the logo)
JUNK = {"FOLLOW US", "BREAKING NEWS", "BREAKING", "LIVE", "NEWS", "इंडिया", "1st", "TATA PLAY", "airtel"}
LATIN_JUNK = re.compile(r"^[a-z]{1,3}$")     # "st", "i": logo and noise. PM, STF, JDA stay.
DEVA = re.compile(r"[ऀ-ॿ]")
MIN_SCORE = 0.6                              # OCR words below this confidence are dropped
MAX_OTHER = 12                               # other screen text lines kept


def sim(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def px(box, w, h):
    return int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)


# ---------- 1. frames ----------
def head_frames(ffmpeg: str, clip: Path, duration: float, work: Path, timeout: float = 180) -> list[Path]:
    work.mkdir(parents=True, exist_ok=True)
    for old in work.glob("*.jpg"):
        old.unlink()
    subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-y", "-ss", "1", "-t", f"{min(duration, HEAD_S):.2f}", "-i", str(clip),
                    "-vf", f"fps=1/{STEP_S},scale=1280:-2", "-q:v", "3", str(work / "c%03d.jpg")],
                   timeout=timeout, check=True, capture_output=True, stdin=subprocess.DEVNULL)
    return sorted(work.glob("c[0-9][0-9][0-9].jpg"))


# ---------- 2-4. screen text ----------
def bar_thumb(im):
    return im.crop(px(BAR_HASH_BOX, *im.size)).convert("L").resize((256, 24))


def group_frames(frames: list[Path]) -> list[list[int]]:
    """One group per bar picture; a line that comes back later joins its first group"""
    groups, thumbs = [], []
    for i, f in enumerate(frames):
        with Image.open(f) as im:
            th = bar_thumb(im)
        for g, k in zip(groups, thumbs):
            if ImageStat.Stat(ImageChops.difference(th, k)).mean[0] < BAR_DIFF:
                g.append(i)
                break
        else:
            groups.append([i])
            thumbs.append(th)
    return groups


def clean_tokens(tokens: list[str]) -> list[str]:
    return [w for w in tokens if w.strip() and not LATIN_JUNK.match(w) and w not in JUNK and re.search(r"[ऀ-ॿA-Za-z0-9]", w)]


def bar_reading(res) -> str:
    words = [(int(b[0]), t.strip()) for t, s, b in zip(res["rec_texts"], res["rec_scores"], res["rec_boxes"]) if s >= MIN_SCORE]
    return " ".join(clean_tokens([w for _, w in sorted(words)]))


def medoid(readings: list[str]) -> str:
    """Vote: the reading most like all the others (an exact repeat wins outright)"""
    c = Counter(readings)
    return max(c, key=lambda r: (sum(sim(r, o) * n for o, n in c.items()), c[r], len(r)))


def bar_lines(groups: list[list[int]], readings: list[str]) -> list[dict]:
    """One line per bar picture (similar readings of different groups merged), half-drawn and repeated lines removed,
    in the order they first showed: [{text, secs, firstS}]"""
    lines = [{"readings": [readings[i] for i in g if len(readings[i]) >= 4], "frames": list(g)} for g in groups]
    merged = []
    for ln in (x for x in lines if x["readings"]):
        txt = medoid(ln["readings"])
        for m in merged:
            if sim(txt, medoid(m["readings"])) >= 0.8:
                m["readings"] += ln["readings"]
                m["frames"] += ln["frames"]
                break
        else:
            merged.append(ln)
    out = [{"text": medoid(m["readings"]), "frames": sorted(m["frames"])} for m in merged]
    keep = [x for x in out
            if len(x["text"]) >= 6 and (DEVA.search(x["text"]) or len(x["text"]) >= 10)
            and not any(len(o["text"]) > len(x["text"]) * 1.25
                        and (sim(x["text"], o["text"][:len(x["text"])]) >= 0.8 or x["text"] in o["text"])
                        for o in out if o is not x)]
    keep.sort(key=lambda x: x["frames"][0])
    return [{"text": x["text"], "secs": len(x["frames"]) * STEP_S, "firstS": 1 + x["frames"][0] * STEP_S} for x in keep]


def panel_rows(res, ox: int, oy: int) -> list[str]:
    words = [((int(b[1]) + int(b[3])) // 2 + oy, int(b[0]) + ox, t.strip())
             for t, s, b in zip(res["rec_texts"], res["rec_scores"], res["rec_boxes"]) if s >= MIN_SCORE and t.strip()]
    rows, cur = [], None
    for y, x, w in sorted(words):
        if cur is None or abs(y - cur) > 18:
            rows.append([])
            cur = y
        rows[-1].append((x, w))
    return [" ".join(clean_tokens([w for _, w in sorted(r)])) for r in rows]


def crops(frames: list[Path], groups: list[list[int]]) -> list[tuple[Path, str, int, int]]:
    """The bar of every frame, the place tag and right panel of each group's first frame: (file, kind, x, y)"""
    jobs = []
    for f in frames:
        with Image.open(f) as im:
            b = px(ROI["bar"], *im.size)
            p = f.with_name(f"{f.stem}_bar.jpg")
            im.crop(b).save(p, quality=90)
            jobs.append((p, "bar", b[0], b[1]))
    for f in (frames[g[0]] for g in groups):
        with Image.open(f) as im:
            for name in ("slug", "right"):
                b = px(ROI[name], *im.size)
                p = f.with_name(f"{f.stem}_{name}.jpg")
                im.crop(b).save(p, quality=90)
                jobs.append((p, name, b[0], b[1]))
    return jobs


def screen_text(groups: list[list[int]], jobs: list[tuple[Path, str, int, int]], results: list) -> tuple[list[dict], list[str]]:
    readings = [bar_reading(r) for j, r in zip(jobs, results) if j[1] == "bar"]
    other, seen = [], []
    for (_p, kind, ox, oy), r in zip(jobs, results):
        if kind != "bar":
            for line in panel_rows(r, ox, oy):
                if len(line) >= 4 and line not in JUNK and not any(sim(line, s) >= 0.85 for s in seen):
                    seen.append(line)
                    other.append(line)
    return bar_lines(groups, readings), other[:MAX_OTHER]


def load_ocr():
    """PaddleOCR on the GPU. Call it after ctranslate2 is imported (Whisper's CUDA libraries load first)."""
    from paddleocr import PaddleOCR

    return PaddleOCR(lang="hi", device="gpu", text_detection_model_name="PP-OCRv5_mobile_det",
                     text_recognition_model_name="devanagari_PP-OCRv5_mobile_rec",
                     text_det_limit_side_len=960, text_det_limit_type="max",
                     use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)


def ocr_crops(ocr, jobs: list[tuple[Path, str, int, int]]) -> list:
    return list(ocr.predict([str(j[0]) for j in jobs])) if jobs else []


def _check(argv: list[str]) -> None:
    """setup.ps1's check: loads the models in the service's order and reads one clip's screen when given"""
    import json
    import tempfile

    sys.stdout.reconfigure(encoding="utf-8")
    t = time.perf_counter()
    import ctranslate2  # noqa: F401  Whisper's CUDA libraries load before Paddle's (WinError 127 otherwise)

    ocr = load_ocr()
    print(f"OCR loaded in {time.perf_counter() - t:.1f} s")
    t = time.perf_counter()
    from faster_whisper import WhisperModel

    WhisperModel(str(MODELS / "whisper" / "large-v3"), device="cuda", compute_type="float16")
    print(f"Whisper large-v3 loaded in {time.perf_counter() - t:.1f} s")
    for clip in argv:
        path = Path(clip)
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=60, check=True).stdout.strip()
        with tempfile.TemporaryDirectory() as tmp:
            t = time.perf_counter()
            frames = head_frames("ffmpeg", path, float(out or 0), Path(tmp))
            groups = group_frames(frames)
            jobs = crops(frames, groups)
            lines, other = screen_text(groups, jobs, ocr_crops(ocr, jobs))
        print(json.dumps({"clip": path.name, "tookS": round(time.perf_counter() - t, 2), "barLines": lines, "otherText": other},
                         ensure_ascii=False, indent=1))


if __name__ == "__main__":
    if sys.argv[1:2] != ["--check"]:
        sys.exit(__doc__)
    _check(sys.argv[2:])
