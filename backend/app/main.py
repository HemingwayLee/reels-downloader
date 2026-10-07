import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from app import models
from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.downloader import normalize_reels_url, run_download_job
from app.library import router as library_router
from app.schemas import DownloadJobCreate, DownloadJobRead
from app.youtube import router as youtube_router

# Show the app's own INFO logs (e.g. skipped reels) next to uvicorn's.
logging.basicConfig(format="%(levelname)s:     %(name)s - %(message)s")
logging.getLogger("app").setLevel(logging.INFO)

DbSession = Annotated[Session, Depends(get_db)]


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Simple bootstrap for dev; switch to Alembic migrations once the schema grows.
    Base.metadata.create_all(bind=engine)
    # create_all doesn't add columns to existing tables.
    with engine.begin() as conn:
        conn.execute(text(
            "ALTER TABLE download_jobs "
            "ADD COLUMN IF NOT EXISTS skip_existing BOOLEAN NOT NULL DEFAULT TRUE"
        ))
    # Jobs run in-process, so any still "running" were cut off by a restart.
    with SessionLocal() as db:
        db.execute(
            update(models.DownloadJob)
            .where(models.DownloadJob.status.not_in(["done", "failed"]))
            .values(status="failed", error="Interrupted by server restart")
        )
        db.commit()
    yield


app = FastAPI(title="Reels Downloader API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


@api.get("/health")
def health(db: DbSession) -> dict[str, str]:
    try:
        db.execute(text("SELECT 1"))
        database = "ok"
    except Exception:
        database = "unavailable"
    return {"status": "ok", "database": database}


@api.get("/downloads", response_model=list[DownloadJobRead])
def list_downloads(db: DbSession):
    return db.scalars(
        select(models.DownloadJob).order_by(models.DownloadJob.id.desc()).limit(20)
    ).all()


@api.post("/downloads", response_model=DownloadJobRead, status_code=201)
def create_download(payload: DownloadJobCreate, db: DbSession, tasks: BackgroundTasks):
    try:
        normalize_reels_url(str(payload.page_url))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    job = models.DownloadJob(
        page_url=str(payload.page_url),
        count=payload.count,
        skip_custom_covers=payload.skip_custom_covers,
        skip_existing=payload.skip_existing,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    tasks.add_task(run_download_job, job.id)
    return job


@api.get("/downloads/{job_id}", response_model=DownloadJobRead)
def get_download(job_id: int, db: DbSession):
    job = db.get(models.DownloadJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


api.include_router(library_router)
api.include_router(youtube_router)
app.include_router(api)
