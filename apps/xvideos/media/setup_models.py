"""Puts the media service's models in digital\\x-requirements\\models (run by setup.ps1).

    python -I setup_models.py <x-requirements folder>

    models\\paddle\\official_models\\PP-OCRv5_mobile_det, devanagari_PP-OCRv5_mobile_rec   (PaddleOCR, about 0.1 GB)
    models\\whisper\\large-v3                                                            (faster-whisper, about 3 GB)

A model already on this PC (PaddleX's ~/.paddlex, Hugging Face's ~/.cache) is copied; otherwise it is downloaded at a
pinned revision. A model already in place is left alone.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

PADDLE = ("PP-OCRv5_mobile_det", "devanagari_PP-OCRv5_mobile_rec")
WHISPER_REPO = "Systran/faster-whisper-large-v3"
WHISPER_REVISION = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
WHISPER_FILES = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json")


def _copy(src: Path, dst: Path) -> None:
    """Copies a folder, following links (Hugging Face's cache links its files to blobs), into place in one move"""
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(src, tmp, symlinks=False)
    tmp.rename(dst)


def paddle(models: Path) -> None:
    for name in PADDLE:
        dst = models / "paddle" / "official_models" / name
        if (dst / "inference.pdiparams").is_file():
            print(f"  paddle {name}: in place")
            continue
        src = Path.home() / ".paddlex" / "official_models" / name
        if (src / "inference.pdiparams").is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.rmtree(dst, ignore_errors=True)  # a copy cut short earlier
            _copy(src, dst)
            print(f"  paddle {name}: copied from {src}")
        else:
            # PaddleOCR downloads it into PADDLE_PDX_CACHE_HOME on the first load (headline.py --check)
            print(f"  paddle {name}: downloaded on the first load")


def whisper(models: Path) -> None:
    dst = models / "whisper" / "large-v3"
    if all((dst / f).is_file() for f in WHISPER_FILES):
        print("  whisper large-v3: in place")
        return
    snap = Path.home() / ".cache" / "huggingface" / "hub" / "models--Systran--faster-whisper-large-v3" / "snapshots" / WHISPER_REVISION
    dst.parent.mkdir(parents=True, exist_ok=True)
    if all((snap / f).is_file() for f in WHISPER_FILES):
        shutil.rmtree(dst, ignore_errors=True)  # a copy cut short earlier (no good copy is lost: one was checked above)
        _copy(snap, dst)
        print(f"  whisper large-v3: copied from {snap}")
        return
    from huggingface_hub import snapshot_download

    tmp = dst.with_name(dst.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    snapshot_download(WHISPER_REPO, revision=WHISPER_REVISION, local_dir=tmp, allow_patterns=list(WHISPER_FILES))
    shutil.rmtree(dst, ignore_errors=True)
    tmp.rename(dst)
    print(f"  whisper large-v3: downloaded ({WHISPER_REPO}@{WHISPER_REVISION[:8]})")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: setup_models.py <x-requirements folder>")
    models = Path(sys.argv[1]).resolve() / "models"
    paddle(models)
    whisper(models)


if __name__ == "__main__":
    main()
