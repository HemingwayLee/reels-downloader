# reels-downloader

A Chrome extension that downloads the newest reels of a Facebook page, skipping reels
whose cover was designed or uploaded by the creator.

## Build

```sh
cd extension
npm install
npm run build
```

This bundles `extension/src/` (with WebLLM and OpenCC from `node_modules`) into
`extension/dist/`. Run `npm run build` again after changing anything in `src/`, then
click the reload button on the extension's card in `chrome://extensions`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/dist/` folder.
3. Pin **Reels Downloader** to the toolbar.
4. For titles, also install **WebLLM Model Manager** from
   `~/Desktop/code/projects/demo-webllm/extension` and download a model in it. Qwen
   models handle Chinese captions best (e.g. `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`).

## Usage

1. Log in to Facebook in Chrome and open a page's Reels tab, e.g.
   `https://www.facebook.com/rayshinlife/reels/`.
2. Click the extension's toolbar icon to open the side panel next to the page.
3. Enter how many reels you want (N), pick a title model, and press **Run**.

The extension scrolls the reels tab to collect reels, newest first, and saves each one to
`Downloads/reels/<page>/<reel id>.mp4`. Keep the tab on the reels page and the side panel
open until the job finishes; **Stop** ends it after the current reel.

With **Only reels without a custom cover** on (the default), reels whose cover doesn't
match the video's first frame are passed over and the next ones are checked instead, so
you still get N reels.

Reels already in `Downloads/reels/<page>/` are skipped too. To check the disk, the
extension needs read access to your Downloads folder: click **Choose…** in the side panel
and pick it once (Chrome may ask again after a restart; it prompts when you press **Run**).
Without it, only Chrome's download history is checked, which forgets everything if you
clear the history.

With **Save title & description** on (the default), each video gets a `<reel id>.json`
next to it:

```json
{
  "url": "https://www.facebook.com/reel/1010918252022692",
  "title": "蘋果榕：像青蘋果的果樹",
  "description": "蘋果榕這種果樹，果實像青蘋果的味道，\n長果方式像樹葡萄，…"
}
```

`description` is the reel's caption. `title` is the caption summarized by the chosen model,
which runs in WebLLM Model Manager on your GPU; nothing is sent to a server. A caption in
Traditional Chinese always gets a Taiwan-style Traditional Chinese title, even if the model
answers in Simplified. `title` is `null` when the reel has no caption or no model is
available.

To grab one specific reel, paste its URL (`facebook.com/reel/<id>`, a `/videos/<id>` or
`/watch/?v=<id>` link, or just the ID) under **By URL** and press **Download**. The cover
check doesn't apply there: the reel is downloaded whatever its cover. Any Facebook page
must be open in the tab. The reel goes to `Downloads/reels/<page>/` if that tab is a page's
Reels tab or the folder chosen at the top is a page's folder (`Downloads/reels/<page>/`,
one holding `.mp4` files), else straight into `Downloads/reels/`, with its `.json` if **Save title &
description** is on.

Videos are Facebook's progressive HD MP4 (H.264/AAC, usually 720p), which QuickTime plays.

## Upload to YouTube

The side panel's **YouTube** tab uploads downloaded reels to your channel, one at a time,
using each reel's `.json`: `title` becomes the video title (the first line of the
description if there's no title, the reel ID if there's neither) and `description` the
video description. Reels without a `.json` can't be uploaded.

One-time setup, since Google requires each app that uploads to have its own OAuth client:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), enable the
   YouTube Data API v3 and add your Google account as a test user on the OAuth consent
   screen.
2. Create an OAuth client ID of type **Web application** and add the redirect URI shown
   under **OAuth client setup** in the YouTube tab
   (`https://<extension id>.chromiumapp.org`, no trailing `/`). An unpacked extension's ID comes from its
   folder path, so keep loading it from the same `extension/dist/` folder.
3. Paste the client ID and client secret into the YouTube tab and click **Sign in with
   Google**, then pick your account in Google's account chooser. The extension keeps a
   refresh token, so you stay signed in. (While the consent screen is in **Testing**, Google
   expires it after 7 days; just sign in again.)

The tab works on the folder chosen at the top of the side panel: that folder itself if it
holds `.mp4` files (e.g. `Downloads/reels/<page>/`, or a folder saved by the old web app),
otherwise its `reels/<page>/` for the Facebook page open in the current tab. With no folder
chosen, it shows nothing.

The folder's videos are shown as thumbnails, oldest first, marked **On YouTube** or
**No .json**. Click one to see the title and description from its `.json` (and the title
YouTube will get), play the video, and **Upload to YouTube**. Videos go up **private**;
change the visibility in YouTube Studio when you're ready. After the upload the video ID is
written back into the reel's `.json`, so it is never uploaded twice:

```json
"youtube": { "video_id": "5ipl_RAC7Kc", "privacy": "private", "uploaded_at": "2026-10-12T10:00:00.000Z" }
```

YouTube's default API quota allows about 6 uploads a day.

## How it works

- `page.js` runs inside the Facebook tab, so it uses your login: it scrolls the reels tab
  for `/reel/<id>` links and fetches each reel's page for its video, caption, first-frame
  and cover URLs. Facebook only includes those in same-origin requests that ask for HTML.
- `cover.js` compares the cover with the first frame (SSIM on 256×256 grayscale): auto
  covers score ~0.98–1.0, designed covers below ~0.2. When the page has no first-frame
  image (logged-in pages often don't), it decodes the video's first frame instead.
- `youtube.js` signs in with `chrome.identity.launchWebAuthFlow` (authorization-code flow
  with PKCE and the client secret, for a refresh token) and uploads with the YouTube Data API's resumable upload; `upload.js`
  is the YouTube tab, reading and writing the files through the chosen Downloads folder.
- `llm.js` asks WebLLM Model Manager (extension ID `kpfphjjelobankiknfkcigkcfnnhcddk`)
  for its downloaded models and has the chosen one write each title.
- `sidepanel.js` drives the job and saves files with `chrome.downloads`.
