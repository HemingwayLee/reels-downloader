from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Text, false, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class DownloadJob(Base):
    __tablename__ = "download_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    page_url: Mapped[str] = mapped_column(String(2048))
    count: Mapped[int] = mapped_column(Integer)
    # Only keep reels whose cover is the video's first frame (no designed cover).
    skip_custom_covers: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    # Skip reels already in the folder or deleted from it, so `count` means new reels.
    skip_existing: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    # pending -> collecting -> downloading -> done | failed
    status: Mapped[str] = mapped_column(String(32), default="pending")
    # Subfolder of the downloads dir, named after the page.
    output_dir: Mapped[str | None] = mapped_column(String(2048))
    files: Mapped[list[str]] = mapped_column(JSON, default=list)
    failed: Mapped[list[str]] = mapped_column(JSON, default=list)
    # Reels passed over by the cover filter, as {"url", "reason"} entries.
    skipped: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class YoutubeAccount(Base):
    """The one YouTube account uploads go to; a single row with id 1."""

    __tablename__ = "youtube_account"

    id: Mapped[int] = mapped_column(primary_key=True)
    # OAuth client from Google Cloud Console (type "Web application"), entered in the UI.
    client_id: Mapped[str] = mapped_column(String(512))
    client_secret: Mapped[str] = mapped_column(String(512))
    # Authorized-user JSON from google-auth (includes the refresh token); null when signed out.
    token: Mapped[str | None] = mapped_column(Text)
    channel: Mapped[str | None] = mapped_column(String(512))
