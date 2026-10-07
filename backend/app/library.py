"""Browse downloaded videos: folders, files, cached thumbnails, captions and the videos themselves."""

import json
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings
from app.schemas import LibraryFile, LibraryFolder, ReelCaption

router = APIRouter(prefix="/library", tags=["library"])

# Hidden so it isn't listed as a folder; thumbnails mirror the folder layout inside it.
THUMBNAILS_DIR = ".thumbnails"
# Per folder: IDs of reels deleted from the library, so downloads don't bring them back.
DELETED_REELS_FILE = ".deleted-reels.json"
THUMBNAIL_WIDTH = 360


def _is_video(path: Path) -> bool:
    # yt-dlp's in-progress files (<id>.f399.mp4, <id>.temp.mp4) and the re-encode's
    # <id>.h264.mp4 all have an extra dot in the stem.
    return path.is_file() and path.suffix == ".mp4" and "." not in path.stem


def load_deleted_reels(folder: Path) -> set[str]:
    path = folder / DELETED_REELS_FILE
    return set(json.loads(path.read_text(encoding="utf-8"))) if path.is_file() else set()


def _remember_deleted(folder: Path, reel_id: str) -> None:
    ids = load_deleted_reels(folder) | {reel_id}
    (folder / DELETED_REELS_FILE).write_text(json.dumps(sorted(ids)), encoding="utf-8")


def _folder(name: str) -> Path:
    root = settings.downloads_dir.resolve()
    path = (root / name).resolve()
    if name.startswith(".") or path.parent != root or not path.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")
    return path


def _video(folder: str, name: str) -> Path:
    path = (_folder(folder) / name).resolve()
    if path.parent.name != folder or not _is_video(path):
        raise HTTPException(status_code=404, detail="File not found")
    return path


def _make_thumbnail(video: Path, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.jpg")
    # A frame 1s in skips fade-ins; very short clips fall back to the first frame.
    for seek in ("1", "0"):
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", seek, "-i", str(video),
             "-frames:v", "1", "-vf", f"scale={THUMBNAIL_WIDTH}:-2", "-q:v", "4", str(tmp)],
            capture_output=True,
        )
        if tmp.exists() and tmp.stat().st_size:
            # Rename so concurrent requests never serve a half-written image.
            tmp.replace(out)
            return
    raise HTTPException(status_code=500, detail="Could not create thumbnail")


@router.get("", response_model=list[LibraryFolder])
def list_folders():
    root = settings.downloads_dir
    if not root.is_dir():
        return []
    folders = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    return sorted(
        (LibraryFolder(name=p.name, file_count=sum(map(_is_video, p.iterdir())))
         for p in folders),
        key=lambda f: f.name.lower(),
    )


@router.get("/{folder}", response_model=list[LibraryFile])
def list_files(folder: str):
    files = [p for p in _folder(folder).iterdir() if _is_video(p)]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        LibraryFile(name=p.name, size=p.stat().st_size, modified=p.stat().st_mtime)
        for p in files
    ]


def _thumbnail(folder: str, video: Path) -> Path:
    return settings.downloads_dir / THUMBNAILS_DIR / folder / f"{video.stem}.jpg"


@router.get("/{folder}/{name}/thumbnail")
def get_thumbnail(folder: str, name: str):
    video = _video(folder, name)
    thumb = _thumbnail(folder, video)
    if not thumb.exists() or thumb.stat().st_mtime < video.stat().st_mtime:
        _make_thumbnail(video, thumb)
    return FileResponse(thumb, media_type="image/jpeg")


@router.get("/{folder}/{name}/caption", response_model=ReelCaption)
def get_caption(folder: str, name: str):
    caption = _video(folder, name).with_suffix(".json")
    if not caption.is_file():
        # Videos downloaded before captions were saved have no .json.
        raise HTTPException(status_code=404, detail="No caption saved for this video")
    return ReelCaption.model_validate_json(caption.read_text(encoding="utf-8"))


@router.get("/{folder}/{name}")
def get_video(folder: str, name: str):
    return FileResponse(_video(folder, name), media_type="video/mp4")


@router.delete("/{folder}/{name}", status_code=204)
def delete_video(folder: str, name: str):
    """Deletes the video, its caption .json and its cached thumbnail (not the YouTube copy).

    The reel is remembered so later downloads skip it.
    """
    video = _video(folder, name)
    _remember_deleted(video.parent, video.stem)
    video.with_suffix(".json").unlink(missing_ok=True)
    _thumbnail(folder, video).unlink(missing_ok=True)
    video.unlink()
