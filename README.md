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

Videos are Facebook's progressive HD MP4 (H.264/AAC, usually 720p), which QuickTime plays.

## How it works

- `page.js` runs inside the Facebook tab, so it uses your login: it scrolls the reels tab
  for `/reel/<id>` links and fetches each reel's page for its video, caption, first-frame
  and cover URLs. Facebook only includes those in same-origin requests that ask for HTML.
- `cover.js` compares the cover with the first frame (SSIM on 256×256 grayscale): auto
  covers score ~0.98–1.0, designed covers below ~0.2. When the page has no first-frame
  image (logged-in pages often don't), it decodes the video's first frame instead.
- `llm.js` asks WebLLM Model Manager (extension ID `kpfphjjelobankiknfkcigkcfnnhcddk`)
  for its downloaded models and has the chosen one write each title.
- `sidepanel.js` drives the job and saves files with `chrome.downloads`.
