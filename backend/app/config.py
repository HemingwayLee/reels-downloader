from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://app:app@localhost:5432/app"
    cors_origins: list[str] = ["http://localhost:5173"]
    downloads_dir: Path = Path("downloads")
    # Must be listed under the YouTube OAuth client's "Authorized redirect URIs". Google sends
    # the browser back to the frontend, which passes the code on to POST /api/youtube/callback.
    youtube_redirect_uri: str = "http://localhost:5173"


settings = Settings()
