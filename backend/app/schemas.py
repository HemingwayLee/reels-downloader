from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class DownloadJobCreate(BaseModel):
    page_url: HttpUrl
    count: int = Field(ge=1, le=200)
    skip_custom_covers: bool = False
    skip_existing: bool = True


class SkippedReel(BaseModel):
    url: str
    reason: str


class DownloadJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    page_url: str
    count: int
    skip_custom_covers: bool
    skip_existing: bool
    status: str
    output_dir: str | None
    files: list[str]
    failed: list[str]
    skipped: list[SkippedReel]
    error: str | None
    created_at: datetime


class LibraryFolder(BaseModel):
    name: str
    file_count: int


class LibraryFile(BaseModel):
    name: str
    size: int
    # Unix timestamp (seconds).
    modified: float


class YoutubeUpload(BaseModel):
    video_id: str
    privacy: str
    uploaded_at: datetime


class ReelCaption(BaseModel):
    """A reel's caption and its summary, saved next to the video as <id>.json."""

    url: str
    text: str
    summary: str | None
    # Set once the video has been uploaded to YouTube.
    youtube: YoutubeUpload | None = None


class YoutubeStatus(BaseModel):
    # An OAuth client has been saved, so signing in can work.
    configured: bool
    connected: bool
    channel: str | None = None
    # Shown (and prefilled) in the UI; the secret is never sent back.
    client_id: str | None = None
    redirect_uri: str


class YoutubeClient(BaseModel):
    client_id: str = Field(min_length=1, max_length=512)
    client_secret: str = Field(min_length=1, max_length=512)


class YoutubeCallback(BaseModel):
    """The query parameters Google redirects the browser back with."""

    state: str
    code: str | None = None
    error: str | None = None


class YoutubeUploadCreate(BaseModel):
    folder: str
    name: str
    privacy: Literal["private", "unlisted", "public"] = "private"
