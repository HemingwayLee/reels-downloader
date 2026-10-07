"""Upload downloaded reels to the user's YouTube channel (summary as title, caption as description).

The OAuth client and the signed-in account's token are entered/created from the UI and
kept in the youtube_account table.
"""

import json
import logging
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.library import _video
from app.models import YoutubeAccount
from app.schemas import (
    ReelCaption,
    YoutubeCallback,
    YoutubeClient,
    YoutubeStatus,
    YoutubeUpload,
    YoutubeUploadCreate,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/youtube", tags=["youtube"])
DbSession = Annotated[Session, Depends(get_db)]

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    # Only to show which channel is connected.
    "https://www.googleapis.com/auth/youtube.readonly",
]
ACCOUNT_ID = 1
TITLE_MAX_CHARS = 100
DESCRIPTION_MAX_BYTES = 5000
CATEGORY_PEOPLE_AND_BLOGS = "22"

# OAuth state -> PKCE code verifier, kept between /auth and /callback.
_pending_logins: dict[str, str] = {}
# One upload at a time, so a double-clicked button can't upload a video twice.
_upload_lock = threading.Lock()


def _flow(account: YoutubeAccount, **kwargs):
    from google_auth_oauthlib.flow import Flow

    config = {"web": {
        "client_id": account.client_id,
        "client_secret": account.client_secret,
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }}
    return Flow.from_client_config(
        config, scopes=SCOPES, redirect_uri=settings.youtube_redirect_uri, **kwargs
    )


def _credentials(db: Session, account: YoutubeAccount | None):
    """The signed-in account's credentials, refreshed if expired; None if signed out or revoked."""
    from google.auth.exceptions import RefreshError
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if account is None or not account.token:
        return None
    creds = Credentials.from_authorized_user_info(json.loads(account.token), SCOPES)
    if not creds.valid:
        try:
            creds.refresh(Request())
        except RefreshError:
            log.warning("YouTube sign-in was revoked or expired; signing out")
            account.token = account.channel = None
            db.commit()
            return None
        account.token = creds.to_json()
        db.commit()
    return creds


def _youtube(creds):
    from googleapiclient.discovery import build

    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def _google_error(e: Exception) -> str:
    # HttpError.reason holds YouTube's message, e.g. "The user has exceeded the number
    # of videos they may upload."
    return getattr(e, "reason", None) or str(e)


def _back_to_app(**params: str) -> RedirectResponse:
    # Relative, so the browser lands back on the frontend that proxied the request.
    return RedirectResponse("/?" + urlencode(params))


def _title(caption: ReelCaption, video: Path) -> str:
    # YouTube titles are one line, at most 100 characters, without "<" or ">".
    title = " ".join((caption.summary or caption.text).split())
    title = title.replace("<", "").replace(">", "")[:TITLE_MAX_CHARS].strip()
    return title or video.stem


def _description(text: str) -> str:
    text = text.replace("<", "").replace(">", "")
    return text.encode("utf-8")[:DESCRIPTION_MAX_BYTES].decode("utf-8", "ignore")


@router.get("/status", response_model=YoutubeStatus)
def status(db: DbSession):
    account = db.get(YoutubeAccount, ACCOUNT_ID)
    return YoutubeStatus(
        configured=account is not None,
        connected=bool(account and account.token),
        channel=account.channel if account else None,
        client_id=account.client_id if account else None,
        redirect_uri=settings.youtube_redirect_uri,
    )


@router.put("/client", response_model=YoutubeStatus)
def save_client(payload: YoutubeClient, db: DbSession):
    account = db.get(YoutubeAccount, ACCOUNT_ID) or YoutubeAccount(id=ACCOUNT_ID)
    account.client_id = payload.client_id.strip()
    account.client_secret = payload.client_secret.strip()
    # A token belongs to the client that issued it.
    account.token = account.channel = None
    db.add(account)
    db.commit()
    return status(db)


@router.get("/auth")
def auth(db: DbSession):
    account = db.get(YoutubeAccount, ACCOUNT_ID)
    if account is None:
        return _back_to_app(youtube_error="Save your OAuth client ID and secret first")
    flow = _flow(account)
    # select_account always shows Google's account chooser instead of silently using the
    # browser's current account; consent makes Google return a refresh token even on a
    # repeat sign-in.
    url, state = flow.authorization_url(
        prompt="select_account consent", include_granted_scopes="true"
    )
    _pending_logins[state] = flow.code_verifier
    return RedirectResponse(url)


@router.post("/callback", response_model=YoutubeStatus)
def callback(payload: YoutubeCallback, db: DbSession):
    """Finishes the sign-in with the ?code=&state= Google sent the browser back with."""
    verifier = _pending_logins.pop(payload.state, None)
    account = db.get(YoutubeAccount, ACCOUNT_ID)
    if payload.error or not payload.code:
        raise HTTPException(status_code=400,
                            detail=f"Google sign-in was cancelled ({payload.error})")
    if verifier is None or account is None:
        raise HTTPException(status_code=400, detail="Sign-in expired; please try again")
    try:
        flow = _flow(account, state=payload.state, code_verifier=verifier)
        flow.fetch_token(code=payload.code)
    except Exception as e:
        log.exception("YouTube sign-in failed")
        raise HTTPException(status_code=400, detail=f"Google sign-in failed: {e}")
    account.token = flow.credentials.to_json()
    try:
        items = _youtube(flow.credentials).channels().list(part="snippet", mine=True).execute()
        account.channel = items["items"][0]["snippet"]["title"]
    except Exception:
        log.exception("Could not look up the signed-in YouTube channel")
        account.channel = None
    db.commit()
    return status(db)


@router.post("/logout", response_model=YoutubeStatus)
def logout(db: DbSession):
    import requests

    account = db.get(YoutubeAccount, ACCOUNT_ID)
    if account and account.token:
        token = json.loads(account.token)
        try:
            # Revoke at Google too, so the app no longer has access to the channel.
            requests.post("https://oauth2.googleapis.com/revoke",
                          params={"token": token.get("refresh_token") or token.get("token")},
                          timeout=10)
        except Exception:
            log.exception("Could not revoke the YouTube token at Google")
        account.token = account.channel = None
        db.commit()
    return status(db)


@router.post("/uploads", response_model=ReelCaption)
def upload(payload: YoutubeUploadCreate, db: DbSession):
    from googleapiclient.http import MediaFileUpload

    video = _video(payload.folder, payload.name)
    caption_path = video.with_suffix(".json")
    if not caption_path.is_file():
        raise HTTPException(status_code=404, detail="No caption saved for this video")

    with _upload_lock:
        caption = ReelCaption.model_validate_json(caption_path.read_text(encoding="utf-8"))
        if caption.youtube:
            raise HTTPException(status_code=409, detail="This video is already on YouTube")
        creds = _credentials(db, db.get(YoutubeAccount, ACCOUNT_ID))
        if creds is None:
            raise HTTPException(status_code=401, detail="Sign in to YouTube first")

        request = _youtube(creds).videos().insert(
            part="snippet,status",
            body={
                "snippet": {
                    "title": _title(caption, video),
                    "description": _description(caption.text),
                    "categoryId": CATEGORY_PEOPLE_AND_BLOGS,
                },
                "status": {
                    "privacyStatus": payload.privacy,
                    "selfDeclaredMadeForKids": False,
                },
            },
            media_body=MediaFileUpload(str(video), mimetype="video/mp4", resumable=True,
                                       chunksize=8 * 1024 * 1024),
        )
        try:
            response = None
            while response is None:
                _, response = request.next_chunk(num_retries=3)
        except Exception as e:
            log.exception("YouTube upload failed for %s", video)
            raise HTTPException(status_code=502, detail=f"YouTube upload failed: {_google_error(e)}")

        log.info("Uploaded %s to YouTube as %s", video.name, response["id"])
        caption.youtube = YoutubeUpload(
            video_id=response["id"], privacy=payload.privacy, uploaded_at=datetime.now(UTC)
        )
        caption_path.write_text(caption.model_dump_json(indent=2), encoding="utf-8")
        return caption
