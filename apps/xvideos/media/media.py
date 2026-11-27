"""X Videos media service: the GPU work on one video clip (screen text, speech, stills), on this machine's GPU.

    ..\\x-requirements\\env\\Scripts\\python.exe -I apps\\xvideos\\media\\media.py
    (reads apps/xvideos/.env, or XVIDEOS_ENV_FILE; the environment wins over the file)

Listens on 127.0.0.1 only (XVIDEOS_MEDIA_PORT, default 8300). The X Videos worker is its only caller: every request
must carry the shared key (XVIDEOS_MEDIA_KEY, header x-xvideos-key) and a JSON body, so a web page in a browser on this
machine cannot trigger work.

    GET  /health   {"ok", "ready": {"ocr", "whisper"}, "errors": {...}, "whisper": "large-v3"}
    POST /screen   {"clipId", "path"}  step 4: the headline bar lines and other screen text (headline.py)
                   → {"screenVersion", "tookS", "durationS", "barLines": [{text, secs, firstS}], "otherText": [...],
                      "timings": {"framesS", "ocrS"}}
    POST /speech   {"clipId", "path", "seconds"?}  the anchor's opening words (first `seconds`, default 45): the
                   headline's fallback when the bar shows fewer than 2 lines
                   → {"tookS", "seconds", "hasAudio", "text"}
    POST /read     {"clipId", "path"}  speech, scene cuts and stills of the whole clip (only with XVIDEOS_SPEECH=on)
                   → {"mediaVersion", "language", "tookS", "durationS", "hasAudio", "transcript": [{at, end, text}],
                      "cutTimes": [...], "frames": [{at, file}], "contactSheet": "<file>" | null}
                   Stills go to XVIDEOS_CACHE/frames/<clipId>/ (built in a temp folder, swapped in when complete).

Status codes: 400 a bad request, 404 file not on the share, 409 that clip is already being worked on by that route,
413 clip too long, 503 a model loading or failed to load, 504 a step timed out, 500 the clip could not be read (with
the reason).

It only reads files under XVIDEOS_SHARE and only writes under XVIDEOS_CACHE. One request at a time holds the GPU; at
most FFMPEG_SLOTS clips decode at once.

Models load in this order (README §6): Whisper's CUDA libraries (ctranslate2) before Paddle's, or Whisper fails with
WinError 127; then PaddleOCR; then Whisper large-v3 from x-requirements\\models\\whisper.

Speech settings (measured 24 Nov 2026, RTX 4090): Whisper large-v3 through faster-whisper, float16, batched 16 in 8 s
chunks, beam 1: about 6 s for a 3 min clip, every word kept (30 s chunks cut Hindi at Whisper's token cap). Audio is
decoded with ffmpeg.
"""

from __future__ import annotations

import hmac
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

MEDIA_DIR = Path(__file__).resolve().parent
XVIDEOS_DIR = MEDIA_DIR.parent


def _load_env_file(path: Path) -> None:
    """KEY=value lines (BOM allowed, matching quotes stripped) for keys the environment does not set to a non-empty value"""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not os.environ.get(key):
            os.environ[key] = value


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"[xvideos-media] {name} is not set (apps/xvideos/.env or the environment)")
    return value


# The worker's settings file, so both share one XVIDEOS_MEDIA_KEY
_load_env_file(Path(os.environ.get("XVIDEOS_ENV_FILE") or XVIDEOS_DIR / ".env"))

# -I leaves the script's folder off sys.path; headline.py sits beside this file
sys.path.insert(0, str(MEDIA_DIR))
import headline  # noqa: E402

MEDIA_VERSION = "xvm-3"
# Bumped when the screen reading changes; kept with each read (clip_screen.screen_version) to tell old reads apart.
# The worker does not read a clip again on its own: delete a day's clip_screen rows to have them read anew.
SCREEN_VERSION = "xvs-1"
MODEL_NAME = os.environ.get("XVIDEOS_WHISPER_MODEL", "large-v3")
PORT = int(os.environ.get("XVIDEOS_MEDIA_PORT", "8300"))
KEY = _required("XVIDEOS_MEDIA_KEY")
SHARE = Path(_required("XVIDEOS_SHARE"))
CACHE = Path(_required("XVIDEOS_CACHE"))
FFMPEG = os.environ.get("XVIDEOS_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("XVIDEOS_FFPROBE", "ffprobe")
# One still every this many seconds: the headline bar rotates about every 10 s
FRAME_EVERY_S = 2.0
# A longer clip gets its stills spread out instead, so a 40-minute debate is not 1,200 files
MAX_FRAMES = 300
# Scene cut threshold (as the 21 Nov dataset: rotating graphics over the same footage are not cuts)
CUT_THRESHOLD = 0.35
# Longer clips are refused: 3 h of 16 kHz float audio is about 700 MB in memory
MAX_DURATION_S = 3 * 3600
# The speech fallback reads the anchor's opening (trial 4: the lead is read in the first 45 s)
SPEECH_S, MAX_SPEECH_S = 45, 120
# The screen read's frames over the first 75 s take a few seconds; this long means the share is stuck
FRAMES_TIMEOUT_S = 180
# Clips decoding at the same time (each is several ffmpeg passes over the share)
FFMPEG_SLOTS = 2
MAX_BODY = 16 * 1024
CLIP_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")

_ocr = None
_whisper = None
_errors: dict[str, str] = {}
_gpu = threading.Lock()
_decode = threading.BoundedSemaphore(FFMPEG_SLOTS)
_inflight: set[tuple[str, str]] = set()
_inflight_lock = threading.Lock()


class BadRequest(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class ReadFailed(Exception):
    """The clip could not be read (bad file, ffmpeg error): 500 with the reason"""


def _check_roots() -> None:
    for name, root in (("XVIDEOS_SHARE", SHARE), ("XVIDEOS_CACHE", CACHE)):
        if not root.is_absolute():
            sys.exit(f"[xvideos-media] {name} must be an absolute path (got {root})")
    share, cache = SHARE.resolve(), CACHE.resolve()
    if share == cache or share in cache.parents or cache in share.parents:
        sys.exit("[xvideos-media] XVIDEOS_SHARE and XVIDEOS_CACHE must not contain each other")


def _load_models() -> None:
    """In the order README §6 needs; a model that fails is reported on /health and as 503 on its routes"""
    global _ocr, _whisper
    # faster-whisper's CUDA libraries from the nvidia-* wheels (requirements.txt)
    try:
        import nvidia  # type: ignore[import-not-found]

        for base in getattr(nvidia, "__path__", []):
            for sub in Path(base).glob("*/bin"):
                os.add_dll_directory(str(sub))
    except ImportError:
        pass
    try:
        import ctranslate2  # noqa: F401  before Paddle (WinError 127 otherwise)
    except Exception as err:
        _errors["whisper"] = f"{type(err).__name__}: {err}"
    try:
        _ocr = headline.load_ocr()
    except Exception as err:  # restart the service to try again
        _errors["ocr"] = f"{type(err).__name__}: {err}"
    if "whisper" in _errors:
        return
    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        local = headline.MODELS / "whisper" / MODEL_NAME
        source = str(local) if (local / "model.bin").is_file() else MODEL_NAME
        _whisper = BatchedInferencePipeline(model=WhisperModel(source, device="cuda", compute_type="float16",
                                                               download_root=str(headline.MODELS / "whisper")))
    except Exception as err:
        _errors["whisper"] = f"{type(err).__name__}: {err}"


def _ffmpeg(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    """ffmpeg / ffprobe with no stdin and overwrite on; raises ReadFailed on a non-zero exit"""
    try:
        out = subprocess.run(args, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired as err:
        raise BadRequest(504, f"{Path(args[0]).name} took longer than {int(timeout)} s") from err
    if out.returncode != 0:
        tail = out.stderr.decode("utf-8", "replace").strip()[-300:]
        raise ReadFailed(f"{Path(args[0]).name} failed: {tail or f'exit {out.returncode}'}")
    return out


def _inside(root: Path, path: str, what: str) -> Path:
    p = Path(path)
    if not p.is_absolute():
        raise BadRequest(400, f"{what} must be an absolute path")
    p = p.resolve()
    r = root.resolve()
    if r not in p.parents:
        raise BadRequest(400, f"{what} is outside {root}")
    return p


def _work_dir(kind: str, clip_id: str) -> Path:
    """A fresh temp folder under XVIDEOS_CACHE/<kind> for one request"""
    d = CACHE.resolve() / kind / f"{clip_id}.tmp-{os.getpid()}-{threading.get_ident()}"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    return d


def probe(path: Path) -> tuple[float, bool]:
    """Length in seconds and whether the file has a sound track"""
    out = _ffmpeg([FFPROBE, "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(path)], 120)
    info = json.loads(out.stdout.decode("utf-8", "replace") or "{}")
    try:
        length = float(info.get("format", {}).get("duration", "nan"))
    except (TypeError, ValueError):
        length = math.nan
    if not math.isfinite(length) or length <= 0:
        raise ReadFailed("the file has no readable length")
    if length > MAX_DURATION_S:
        raise BadRequest(413, f"the clip is {length / 3600:.1f} h long; clips over {MAX_DURATION_S // 3600} h are not read")
    return length, any(s.get("codec_type") == "audio" for s in info.get("streams", []))


def audio(path: Path, length: float, seconds: float | None = None) -> np.ndarray:
    """16 kHz mono float, the whole clip or its first `seconds`; a decode failure is an error (an empty result only
    comes from a clip without sound)"""
    head = ["-t", f"{seconds:.2f}"] if seconds else []
    out = _ffmpeg([FFMPEG, "-nostdin", "-v", "error", *head, "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                  max(300.0, length))
    return np.frombuffer(out.stdout, dtype=np.float32)


def transcript(samples: np.ndarray) -> list[dict]:
    if samples.size < 16000:  # under a second of sound
        return []
    segments, _info = _whisper.transcribe(samples, language="hi", batch_size=16, beam_size=1, chunk_length=8)
    return [{"at": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments if s.text.strip()]


def cut_times(path: Path, length: float) -> list[float]:
    # Scaled down first: the scene score does not need full resolution and the decode is much cheaper
    out = _ffmpeg([FFMPEG, "-nostdin", "-hide_banner", "-i", str(path), "-vf", f"scale=320:-2,select='gt(scene,{CUT_THRESHOLD})',showinfo",
                   "-an", "-f", "null", "-"], max(300.0, length))
    return [round(float(t), 2) for t in re.findall(r"pts_time:([\d.]+)", out.stderr.decode("utf-8", "replace"))]


def stills(path: Path, out_dir: Path, length: float) -> tuple[list[dict], str | None]:
    """Stills every FRAME_EVERY_S (spread wider for long clips) and a 4x3 contact sheet, built in a temp folder and then
    swapped in, so a failed run never leaves the clip without its stills"""
    tmp = out_dir.with_name(f"{out_dir.name}.tmp-{os.getpid()}-{threading.get_ident()}")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        every = max(FRAME_EVERY_S, length / MAX_FRAMES)
        _ffmpeg([FFMPEG, "-nostdin", "-y", "-v", "error", "-i", str(path), "-vf", f"fps=1/{every:.3f},scale=640:-2", "-q:v", "5",
                 str(tmp / "f_%04d.jpg")], max(300.0, length))
        frames = [{"at": round(i * every, 2), "file": f.name} for i, f in enumerate(sorted(tmp.glob("f_*.jpg")))]
        sheet = None
        step = length / 12
        if step >= 0.05:
            try:
                _ffmpeg([FFMPEG, "-nostdin", "-y", "-v", "error", "-i", str(path), "-vf", f"fps=1/{step:.3f},scale=320:-2,tile=4x3",
                         "-frames:v", "1", "-q:v", "5", str(tmp / "sheet.jpg")], max(300.0, length))
                sheet = "sheet.jpg"
            except (ReadFailed, BadRequest):
                sheet = None  # the stills are enough; the sheet is a convenience
        # The old stills move aside before the new ones move in, so a crash between the two never leaves the clip without any
        old = out_dir.with_name(f"{out_dir.name}.old-{os.getpid()}-{threading.get_ident()}")
        if out_dir.exists():
            out_dir.rename(old)
        tmp.rename(out_dir)
        shutil.rmtree(old, ignore_errors=True)
        return frames, sheet
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def read_clip(clip_id: str, path: Path) -> dict:
    t0 = time.perf_counter()
    length, has_audio = probe(path)
    with _decode:
        # Decoded before taking the GPU, so share reads never keep it idle
        samples = audio(path, length) if has_audio else np.zeros(0, dtype=np.float32)
        with _gpu:
            lines = transcript(samples)
        del samples
        cuts = cut_times(path, length)
        frames, sheet = stills(path, CACHE.resolve() / "frames" / clip_id, length)
    return {"mediaVersion": f"{MEDIA_VERSION}/{MODEL_NAME}", "language": "hi", "tookS": round(time.perf_counter() - t0, 2),
            "durationS": round(length, 2), "hasAudio": has_audio, "transcript": lines, "cutTimes": cuts, "frames": frames,
            "contactSheet": sheet}


def screen_clip(clip_id: str, path: Path) -> dict:
    """Step 4's screen read (headline.py): frames in a temp folder under XVIDEOS_CACHE/screen, removed afterwards"""
    t0 = time.perf_counter()
    length, _has_audio = probe(path)
    work = _work_dir("screen", clip_id)
    try:
        with _decode:
            try:
                frames = headline.head_frames(FFMPEG, path, length, work, FRAMES_TIMEOUT_S)
            except subprocess.TimeoutExpired as err:
                raise BadRequest(504, f"ffmpeg took longer than {FRAMES_TIMEOUT_S} s on the clip's first {headline.HEAD_S} s") from err
            except subprocess.CalledProcessError as err:
                tail = (err.stderr or b"").decode("utf-8", "replace").strip()[-300:]
                raise ReadFailed(f"ffmpeg failed: {tail or f'exit {err.returncode}'}") from err
            groups = headline.group_frames(frames)
            jobs = headline.crops(frames, groups)
        t1 = time.perf_counter()
        with _gpu:
            results = headline.ocr_crops(_ocr, jobs)
        lines, other = headline.screen_text(groups, jobs, results)
        t2 = time.perf_counter()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"screenVersion": SCREEN_VERSION, "tookS": round(t2 - t0, 2), "durationS": round(length, 2), "barLines": lines,
            "otherText": other, "timings": {"framesS": round(t1 - t0, 2), "ocrS": round(t2 - t1, 2)}}


def speech_clip(path: Path, seconds: float) -> dict:
    """The anchor's opening words: the first `seconds` of sound, as one text"""
    t0 = time.perf_counter()
    length, has_audio = probe(path)
    text = ""
    if has_audio:
        with _decode:
            samples = audio(path, length, min(seconds, length))
        with _gpu:
            text = " ".join(line["text"] for line in transcript(samples))
    return {"tookS": round(time.perf_counter() - t0, 2), "seconds": round(min(seconds, length), 2), "hasAudio": has_audio, "text": text}


# route → the model it needs
ROUTES = {"/read": "whisper", "/screen": "ocr", "/speech": "whisper"}


class Handler(BaseHTTPRequestHandler):
    server_version = "xvideos-media/3"
    # A client that stops sending gives up its thread after this long
    timeout = 30

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except ConnectionError:
            pass  # the worker gave up waiting (broken pipe, reset, or WinError 10053 aborted); it asks again later

    def _body(self) -> dict:
        if not hmac.compare_digest(self.headers.get("x-xvideos-key", "").encode("utf-8", "replace"), KEY.encode("utf-8")):
            raise BadRequest(403, "missing or wrong x-xvideos-key")
        if not self.headers.get("content-type", "").startswith("application/json"):
            raise BadRequest(415, "the body must be JSON")
        try:
            size = int(self.headers.get("content-length", ""))
        except ValueError as err:
            raise BadRequest(411, "content-length is required") from err
        if size < 0 or size > MAX_BODY:
            raise BadRequest(413, "the request body is too large")
        try:
            req = json.loads(self.rfile.read(size) or b"{}")
        except json.JSONDecodeError as err:
            raise BadRequest(400, "the body is not valid JSON") from err
        if not isinstance(req, dict):
            raise BadRequest(400, "the body must be a JSON object")
        return req

    def do_GET(self) -> None:
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        ready = {"ocr": _ocr is not None, "whisper": _whisper is not None}
        self._send(200, {"ok": not _errors, "ready": ready, "errors": dict(_errors), "whisper": MODEL_NAME,
                         "screenVersion": SCREEN_VERSION})

    def do_POST(self) -> None:
        model = ROUTES.get(self.path)
        if model is None:
            return self._send(404, {"error": "not found"})
        held = None
        try:
            req = self._body()
            if (_ocr if model == "ocr" else _whisper) is None:
                return self._send(503, {"error": _errors.get(model) or f"{model} loading"})
            clip_id = str(req.get("clipId", ""))
            if not CLIP_ID.match(clip_id):
                raise BadRequest(400, "clipId is missing or not an id")
            path = _inside(SHARE, str(req.get("path", "")), "path")
            seconds = req.get("seconds", SPEECH_S)
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not 1 <= seconds <= MAX_SPEECH_S:
                raise BadRequest(400, f"seconds must be a number from 1 to {MAX_SPEECH_S}")
            key = (self.path, clip_id)
            with _inflight_lock:
                if key in _inflight:
                    raise BadRequest(409, "this clip is already being worked on")
                _inflight.add(key)
                held = key
            if not path.is_file():
                raise BadRequest(404, "file not found on the share")
            if self.path == "/read":
                self._send(200, read_clip(clip_id, path))
            elif self.path == "/screen":
                self._send(200, screen_clip(clip_id, path))
            else:
                self._send(200, speech_clip(path, float(seconds)))
        except BadRequest as err:
            self._send(err.status, {"error": str(err)})
        except ReadFailed as err:
            self._send(500, {"error": str(err)})
        except OSError as err:  # the share or the cache failed: worth a retry
            self._send(500, {"error": f"{type(err).__name__}: {err.strerror or err}"})
        except Exception as err:  # recorded by the worker, which retries
            self._send(500, {"error": f"{type(err).__name__}: {err}"})
        finally:
            if held:
                with _inflight_lock:
                    _inflight.discard(held)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[xvideos-media] {self.address_string()} {fmt % args}", flush=True)


def _sweep() -> None:
    """Temp folders a killed run left behind (their names hold that run's process id, so nothing else removes them)"""
    for kind in ("frames", "screen"):
        for d in (CACHE.resolve() / kind).glob("*.tmp-*"):
            shutil.rmtree(d, ignore_errors=True)
        for d in (CACHE.resolve() / kind).glob("*.old-*"):
            shutil.rmtree(d, ignore_errors=True)


def main() -> None:
    _check_roots()
    _sweep()
    threading.Thread(target=_load_models, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[xvideos-media] listening on 127.0.0.1:{PORT}, OCR and Whisper {MODEL_NAME} loading", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
