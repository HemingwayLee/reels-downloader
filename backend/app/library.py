"""Browse downloaded videos: folders, files, cached thumbnails and the videos themselves."""

import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings
from app.schemas import LibraryFile, LibraryFolder

router = APIRouter(prefix="/library", tags=["library"])

# Hidden so it isn't listed as a folder; thumbnails mirror the folder layout inside it.
THUMBNAILS_DIR = ".thumbnails"
THUMBNAIL_WIDTH = 360


def _is_video(path: Path) -> bool:
    # yt-dlp's in-progress files (<id>.f399.mp4, <id>.temp.mp4) and the re-encode's
    # <id>.h264.mp4 all have an extra dot in the stem.
    return path.is_file() and path.suffix == ".mp4" and "." not in path.stem


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


@router.get("/{folder}/{name}/thumbnail")
def get_thumbnail(folder: str, name: str):
    video = _video(folder, name)
    thumb = settings.downloads_dir / THUMBNAILS_DIR / folder / f"{video.stem}.jpg"
    if not thumb.exists() or thumb.stat().st_mtime < video.stat().st_mtime:
        _make_thumbnail(video, thumb)
    return FileResponse(thumb, media_type="image/jpeg")


@router.get("/{folder}/{name}")
def get_video(folder: str, name: str):
    return FileResponse(_video(folder, name), media_type="video/mp4")
