# reels-downloader

- **frontend/** — React + TypeScript + MUI (Vite)
- **backend/** — FastAPI (Python 3.13) + SQLAlchemy
- **db** — PostgreSQL 16

## Usage

Open http://localhost:5173, enter how many reels you want (N) and a Facebook page's
reels URL (e.g. `https://www.facebook.com/rayshinlife/reels/`), then press **Run**.
The backend opens the page in headless Chromium, scrolls the reels tab to collect the
N newest reels, and downloads each one with yt-dlp into `downloads/<page>/<reel id>.mp4`.

Only public pages work (no Facebook login is used). Reels already on disk are skipped.

With **Only reels without a custom cover** on (the default), reels whose cover was
designed or uploaded by the creator are passed over and the next ones are checked
instead, so you still get N reels. A cover counts as custom when it doesn't match the
video's first frame.

Below the job, a Finder-style view shows every downloaded video in a folder as a
thumbnail icon (pick the folder from the dropdown, resize icons with the slider).
Click to select, double-click to play. Thumbnails are generated on first view and
cached in `downloads/.thumbnails/`.

## Development

```sh
docker compose -f docker-compose.dev.yml up --build
```

| Service  | URL                          |
| -------- | ---------------------------- |
| Frontend | http://localhost:5173        |
| API      | http://localhost:8710/api    |
| API docs | http://localhost:8710/docs   |
| Postgres | `localhost:5432` (app / app / db `app`) |

Both apps hot reload: `frontend/` and `backend/` are bind-mounted into their containers,
Vite serves HMR, and uvicorn runs with `--reload`. The frontend proxies `/api` to the backend.

After changing dependencies (`package.json` or `requirements.txt`), rebuild and renew
the `node_modules` volume:

```sh
docker compose -f docker-compose.dev.yml up --build -V
```

Reset the database:

```sh
docker compose -f docker-compose.dev.yml down -v
```
