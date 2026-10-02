from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class DownloadJobCreate(BaseModel):
    page_url: HttpUrl
    count: int = Field(ge=1, le=200)
    skip_custom_covers: bool = False


class SkippedReel(BaseModel):
    url: str
    reason: str


class DownloadJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    page_url: str
    count: int
    skip_custom_covers: bool
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
