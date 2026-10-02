import json
import logging
import re
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from playwright.sync_api import sync_playwright

from app import models
from app.config import settings
from app.db import SessionLocal

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
REEL_ID = re.compile(r"/reel/(\d+)")
# Stop scrolling after this many rounds without new reels appearing.
MAX_STALE_SCROLLS = 6
# Facebook re-encodes an auto cover as its own file, so the cover and first frame are
# compared by content: auto covers score ~0.99 SSIM, designed covers below ~0.1.
SAME_IMAGE_SSIM = 0.9


def normalize_reels_url(page_url: str) -> str:
    """Accept a page URL with or without the /reels/ suffix."""
    parsed = urlparse(page_url)
    host = parsed.hostname or ""
    if host != "facebook.com" and not host.endswith(".facebook.com"):
        raise ValueError("URL must be a facebook.com page")
    path = parsed.path.rstrip("/")
    if not path:
        raise ValueError("URL must point to a Facebook page")
    if not path.endswith("/reels"):
        path += "/reels"
    return f"https://www.facebook.com{path}/"


def collect_reel_ids(
    reels_url: str, count: int, accept: Callable[[str], bool] | None = None
) -> list[str]:
    """Scroll the page's reels tab (newest first) until `count` reel IDs are found.

    If `accept` is given, only reel IDs it returns True for are kept.
    """
    ids: list[str] = []
    seen: set[str] = set()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(
                locale="en-US",
                user_agent=USER_AGENT,
                viewport={"width": 1280, "height": 900},
            )
            page.goto(reels_url, wait_until="domcontentloaded", timeout=60_000)
            stale = 0
            while len(ids) < count and stale < MAX_STALE_SCROLLS:
                hrefs = page.eval_on_selector_all(
                    'a[href*="/reel/"]', "els => els.map(e => e.getAttribute('href'))"
                )
                before = len(seen)
                for href in hrefs:
                    m = REEL_ID.search(href or "")
                    if not m or m.group(1) in seen:
                        continue
                    seen.add(m.group(1))
                    if accept is None or accept(m.group(1)):
                        ids.append(m.group(1))
                    if len(ids) >= count:
                        break
                stale = stale + 1 if len(seen) == before else 0
                # Logged-out visitors get a login dialog; close it so scrolling continues.
                close = page.locator('div[aria-label="Close"]')
                if close.count():
                    try:
                        close.first.click(timeout=1_000)
                    except Exception:
                        pass
                page.mouse.wheel(0, 4_000)
                time.sleep(1.5)
        finally:
            browser.close()
    return ids[:count]


def _json_str(raw: str) -> str:
    """Decode a string literal's contents as embedded in the page's JSON."""
    return json.loads(f'"{raw}"')


def has_custom_cover(ydl: yt_dlp.YoutubeDL, reel_id: str) -> bool:
    """True if the reel's cover image isn't just the video's first frame."""
    with ydl.urlopen(f"https://www.facebook.com/reel/{reel_id}") as res:
        html = res.read().decode("utf-8", "replace")
    rid = re.escape(reel_id)
    first = re.search(rf'"id":"{rid}","first_frame_thumbnail":"([^"]+)"', html)
    cover = re.search(rf'"id":"{rid}"[^{{}}]*?"thumbnailImage":{{"uri":"([^"]+)"', html)
    if not first or not cover:
        raise RuntimeError(f"Cover info not found for reel {reel_id}")
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", _json_str(first.group(1)),
         "-i", _json_str(cover.group(1)), "-lavfi",
         "[0]scale=256:256,format=gray[a];[1]scale=256:256,format=gray[b];"
         "[a][b]ssim=stats_file=-", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stdout
    # The stats file ends with an "All:<score>" field per frame; there's one frame.
    ssim = float(re.search(r"All:([\d.]+)", out).group(1))
    return ssim < SAME_IMAGE_SSIM


def _codec(path: Path, stream: str) -> str | None:
    """Return the codec name of the first `stream` ("v" or "a") in the file, if any."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", f"{stream}:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return out or None


def ensure_quicktime_compatible(path: Path) -> None:
    """Re-encode VP9/AV1 video (and non-AAC audio) to H.264/AAC so QuickTime can play it."""
    vcodec, acodec = _codec(path, "v"), _codec(path, "a")
    if vcodec in (None, "h264") and acodec in (None, "aac"):
        return
    tmp = path.with_suffix(".h264.mp4")
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(path)]
    cmd += ["-c:v", "copy"] if vcodec in (None, "h264") else [
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    ]
    cmd += ["-c:a", "copy"] if acodec in (None, "aac") else ["-c:a", "aac", "-b:a", "192k"]
    cmd += ["-movflags", "+faststart", str(tmp)]
    subprocess.run(cmd, check=True)
    tmp.replace(path)


def run_download_job(job_id: int) -> None:
    with SessionLocal() as db:
        job = db.get(models.DownloadJob, job_id)
        if job is None:
            return

        def update(**fields) -> None:
            for key, value in fields.items():
                setattr(job, key, value)
            db.commit()

        opts = {
            # Best quality is usually 1080p AV1/VP9; it's re-encoded to H.264 after
            # download (see ensure_quicktime_compatible) so QuickTime can play it.
            "format": "bv*+ba/b",
            "merge_output_format": "mp4",
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
        }
        try:
            reels_url = normalize_reels_url(job.page_url)
            page_name = urlparse(reels_url).path.strip("/").split("/")[0]
            output_dir: Path = settings.downloads_dir / page_name
            opts["outtmpl"] = str(output_dir / "%(id)s.%(ext)s")
            with yt_dlp.YoutubeDL(opts) as ydl:
                accept = None
                if job.skip_custom_covers:
                    def accept(reel_id: str) -> bool:
                        url = f"https://www.facebook.com/reel/{reel_id}"
                        try:
                            if not has_custom_cover(ydl, reel_id):
                                return True
                            reason = "Custom cover"
                        except Exception:
                            log.exception("Cover check failed for %s", url)
                            reason = "Cover check failed"
                        log.info("Job %s: skipped %s (%s)", job_id, url, reason)
                        # Assign a new list so SQLAlchemy sees the JSON column changed.
                        update(skipped=[*job.skipped, {"url": url, "reason": reason}])
                        return False

                update(status="collecting")
                reel_ids = collect_reel_ids(reels_url, job.count, accept)
                if not reel_ids:
                    raise RuntimeError(
                        "No reels without a custom cover found"
                        if job.skipped
                        else "No reels found on the page (it may be private or require login)"
                    )

                output_dir.mkdir(parents=True, exist_ok=True)
                update(status="downloading", output_dir=page_name)

                files: list[str] = []
                failed: list[str] = []
                for reel_id in reel_ids:
                    url = f"https://www.facebook.com/reel/{reel_id}"
                    try:
                        info = ydl.extract_info(url, download=True)
                        path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
                        ensure_quicktime_compatible(path)
                        files.append(path.name)
                    except Exception:
                        log.exception("Failed to download %s", url)
                        failed.append(url)
                    # Assign new lists so SQLAlchemy sees the JSON columns changed.
                    update(files=list(files), failed=list(failed))

            update(status="done" if files else "failed",
                   error=None if files else "All downloads failed")
        except Exception as e:
            log.exception("Download job %s failed", job_id)
            update(status="failed", error=str(e))
