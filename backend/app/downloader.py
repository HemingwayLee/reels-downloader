import json
import logging
import re
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from playwright.sync_api import sync_playwright

from app import models
from app.config import settings
from app.db import SessionLocal
from app.library import load_deleted_reels
from app.summarizer import summarize

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
REEL_ID = re.compile(r"/reel/(\d+)")
# Stop scrolling after this many rounds without new reels appearing.
MAX_STALE_SCROLLS = 6
# Facebook stops showing logged-out visitors more reels after about 50 (a login wall);
# this only bounds a page that keeps loading.
MAX_REELS_SCANNED = 300
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


def collect_reel_ids(reels_url: str) -> list[str]:
    """Scroll the page's reels tab and return every reel ID it shows, newest first."""
    ids: list[str] = []
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
            while len(ids) < MAX_REELS_SCANNED and stale < MAX_STALE_SCROLLS:
                hrefs = page.eval_on_selector_all(
                    'a[href*="/reel/"]', "els => els.map(e => e.getAttribute('href'))"
                )
                before = len(ids)
                for href in hrefs:
                    m = REEL_ID.search(href or "")
                    if m and m.group(1) not in ids:
                        ids.append(m.group(1))
                stale = stale + 1 if len(ids) == before else 0
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
    return ids[:MAX_REELS_SCANNED]


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
    # Fetch the images through yt-dlp rather than letting ffmpeg do it: ffmpeg's HTTP
    # client can time out on the CDN where yt-dlp's (headers, retries, proxy) doesn't.
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for name, match in (("first", first), ("cover", cover)):
            path = Path(tmp) / f"{name}.jpg"
            with ydl.urlopen(_json_str(match.group(1))) as res:
                path.write_bytes(res.read())
            paths.append(str(path))
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", paths[0], "-i", paths[1], "-lavfi",
             "[0]scale=256:256,format=gray[a];[1]scale=256:256,format=gray[b];"
             "[a][b]ssim=stats_file=-", "-f", "null", "-"],
            capture_output=True, text=True,
        )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg SSIM failed ({proc.returncode}): {proc.stderr.strip()}")
    out = proc.stdout
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


def write_caption_json(path: Path, url: str, info: dict) -> None:
    """Save the reel's caption and its summary next to the video as <id>.json.

    A reel downloaded again keeps its existing record (e.g. its YouTube upload) and, if
    the caption hasn't changed, its summary.
    """
    caption_path = path.with_suffix(".json")
    existing = json.loads(caption_path.read_text(encoding="utf-8")) if caption_path.exists() else {}
    text = (info.get("description") or "").strip()
    summary = existing.get("summary") if existing.get("text") == text else None
    if text and summary is None:
        try:
            summary = summarize(text)
        except Exception:
            log.exception("Summarizing caption failed for %s", url)
    caption_path.write_text(
        json.dumps({**existing, "url": url, "text": text, "summary": summary},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


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
            # The Python API defaults to no retries (the CLI's defaults don't apply), so
            # one dropped connection from Facebook's CDN would fail the whole reel.
            "retries": 10,
            "fragment_retries": 10,
            "extractor_retries": 3,
            # Back off 1s, 2s, 4s, ... up to 30s between attempts.
            "retry_sleep_functions": {
                kind: lambda n: min(2 ** n, 30) for kind in ("http", "fragment", "extractor")
            },
        }
        try:
            reels_url = normalize_reels_url(job.page_url)
            page_name = urlparse(reels_url).path.strip("/").split("/")[0]
            output_dir: Path = settings.downloads_dir / page_name
            opts["outtmpl"] = str(output_dir / "%(id)s.%(ext)s")
            with yt_dlp.YoutubeDL(opts) as ydl:
                update(status="collecting")
                reel_ids = collect_reel_ids(reels_url)
                if not reel_ids:
                    raise RuntimeError(
                        "No reels found on the page (it may be private or require login)"
                    )

                output_dir.mkdir(parents=True, exist_ok=True)
                update(status="downloading", output_dir=page_name)
                deleted = load_deleted_reels(output_dir) if job.skip_existing else set()

                def skip_reason(reel_id: str) -> str | None:
                    if job.skip_existing:
                        if (output_dir / f"{reel_id}.mp4").exists():
                            return "Already downloaded"
                        if reel_id in deleted:
                            return "Deleted earlier"
                    if job.skip_custom_covers:
                        try:
                            if has_custom_cover(ydl, reel_id):
                                return "Custom cover"
                        except Exception:
                            log.exception("Cover check failed for reel %s", reel_id)
                            return "Cover check failed"
                    return None

                # Newest first; skipped and failed reels don't count, so keep going down
                # the page until `count` reels are downloaded or the page runs out.
                files: list[str] = []
                failed: list[str] = []
                for reel_id in reel_ids:
                    if len(files) >= job.count:
                        break
                    url = f"https://www.facebook.com/reel/{reel_id}"
                    if reason := skip_reason(reel_id):
                        log.info("Job %s: skipped %s (%s)", job_id, url, reason)
                        # Assign a new list so SQLAlchemy sees the JSON column changed.
                        update(skipped=[*job.skipped, {"url": url, "reason": reason}])
                        continue
                    try:
                        info = ydl.extract_info(url, download=True)
                        path = Path(ydl.prepare_filename(info)).with_suffix(".mp4")
                        ensure_quicktime_compatible(path)
                        write_caption_json(path, url, info)
                        files.append(path.name)
                    except Exception:
                        log.exception("Failed to download %s", url)
                        failed.append(url)
                    # Assign new lists so SQLAlchemy sees the JSON columns changed.
                    update(files=list(files), failed=list(failed))

            # Finding nothing new isn't a failure; the UI explains why from `skipped`.
            all_failed = failed and not files
            update(status="failed" if all_failed else "done",
                   error="All downloads failed" if all_failed else None)
        except Exception as e:
            log.exception("Download job %s failed", job_id)
            update(status="failed", error=str(e))
