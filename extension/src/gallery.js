// The YouTube tab's thumbnail grid of the videos in the chosen folder. Clicking a thumbnail
// opens a popup with the title and description from the video's .json, the video, and a
// button to upload it.

import { $ } from "./ui.js";
import { youtubeMetadata } from "./youtube.js";

const THUMB_WIDTH = 216;

// Thumbnail blob URLs already made, by folder, file name, size and modification time, so
// refreshing the tab doesn't decode every video again.
const thumbs = new Map();
// Bumped on every render, so thumbnails for a folder that's no longer shown stop being made.
let generation = 0;
// The object URL of the video playing in the popup, revoked when it closes.
let dialogUrl = null;
// The reel shown in the popup ({dir, id, json}), or null when it's closed.
let shown = null;
// The upload in progress ({id, text}), or null. One at a time; it keeps going if the popup
// closes, and shows again when that reel's popup is reopened.
let uploading = null;
// Set by initGallery: upload(dir, id, onProgress) → {video_id, privacy}, and a callback
// for after an upload.
let upload = null;
let onUploaded = () => {};

/** Wait for `event` on a media element, failing on its "error" event or after `ms`. */
function once(el, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", fail);
      settle(value);
    };
    const ok = () => done(resolve);
    const fail = () => done(reject, new Error("Can't decode the video"));
    const timer = setTimeout(() => done(reject, new Error(`Timed out waiting for ${event}`)), ms);
    el.addEventListener(event, ok);
    el.addEventListener("error", fail);
  });
}

/** A JPEG blob URL of a frame near the start of `file`. */
async function makeThumbnail(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  try {
    video.src = url;
    await once(video, "loadedmetadata");
    // A little past the start: the very first frame is often black.
    video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    await once(video, "seeked");
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.round((THUMB_WIDTH * video.videoHeight) / video.videoWidth) || THUMB_WIDTH * 16 / 9;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    return URL.createObjectURL(blob);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function statusOf(json) {
  if (!json) return { cls: "fail", text: "No .json" };
  if (json.youtube) return { cls: "ok", text: "On YouTube" };
  return null;
}

function tile(dir, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tile";
  const { title } = youtubeMetadata(item.json, item.id);
  button.title = title;
  const frame = document.createElement("div");
  frame.className = "thumb";
  const status = statusOf(item.json);
  if (status) {
    const badge = document.createElement("span");
    badge.className = `badge ${status.cls}`;
    badge.textContent = status.text;
    frame.append(badge);
  }
  const caption = document.createElement("span");
  caption.className = "tile-title";
  caption.textContent = item.json ? title : item.id;
  button.append(frame, caption);
  button.addEventListener("click", () => openDetails(dir, item.id).catch((e) => {
    console.error(e);
    alertInDialog(e.message);
  }));
  return { button, frame };
}

/** Show the videos in `dir` ({id, json} items, in order). `key` names the folder for caching. */
export function renderGallery(dir, items, key) {
  const run = ++generation;
  const tiles = items.map((item) => ({ item, ...tile(dir, item) }));
  $("ytGallery").replaceChildren(...tiles.map((t) => t.button));
  // One video at a time, so a big folder doesn't decode dozens of videos at once.
  (async () => {
    for (const { item, frame } of tiles) {
      if (run !== generation) return;
      try {
        const file = await (await dir.getFileHandle(`${item.id}.mp4`)).getFile();
        const cacheKey = `${key}/${file.name}/${file.size}/${file.lastModified}`;
        if (!thumbs.has(cacheKey)) thumbs.set(cacheKey, await makeThumbnail(file));
        if (run !== generation) return;
        const img = document.createElement("img");
        img.src = thumbs.get(cacheKey);
        img.alt = "";
        frame.prepend(img);
      } catch (e) {
        console.error(`Thumbnail for ${item.id}`, e);
        frame.classList.add("broken");
      }
    }
  })();
}

export function clearGallery() {
  generation++;
  $("ytGallery").replaceChildren();
}

function alertInDialog(message) {
  $("ytDialogStatus").textContent = "";
  $("ytDialogVideo").hidden = true;
  $("ytDialogTitle").textContent = "Couldn't open this video";
  $("ytDialogTitleNote").textContent = message;
  $("ytDialogDescription").textContent = "";
  $("ytDialogReel").hidden = $("ytDialogYoutube").hidden = $("ytDialogUpload").hidden = true;
  $("ytDialogUploadNote").textContent = "";
  $("ytDialog").showModal();
}

/** Open the popup for reel `id`, reading its .json again so it shows what's on disk now. */
async function openDetails(dir, id) {
  let json = null;
  try {
    json = JSON.parse(await (await (await dir.getFileHandle(`${id}.json`)).getFile()).text());
  } catch (e) {
    if (e.name !== "NotFoundError") throw e;
  }
  const file = await (await dir.getFileHandle(`${id}.mp4`)).getFile();

  closeDetails();
  dialogUrl = URL.createObjectURL(file);
  const video = $("ytDialogVideo");
  video.hidden = false;
  video.src = dialogUrl;

  shown = { dir, id, json };
  showStatus();
  $("ytDialogUploadNote").textContent = "";

  const { title } = youtubeMetadata(json, id);
  const savedTitle = json?.title ?? json?.summary;
  const description = json?.description ?? json?.text ?? "";
  $("ytDialogTitle").textContent = savedTitle || title;
  $("ytDialogTitleNote").textContent = !json ? ""
    : !savedTitle ? "No title in the .json — this is what YouTube will get."
    : title !== savedTitle ? `YouTube will get: “${title}”` : "";
  $("ytDialogDescription").textContent = description || (json ? "No description." : "");
  $("ytDialogDescription").classList.toggle("muted-text", !description);

  const reelUrl = json?.url ?? (/^\d+$/.test(id) ? `https://www.facebook.com/reel/${id}` : null);
  $("ytDialogReel").hidden = !reelUrl;
  if (reelUrl) $("ytDialogReel").href = reelUrl;
  $("ytDialog").showModal();
}

/** Update the popup's status line, YouTube link and Upload button for `shown`. */
function showStatus() {
  const { id, json } = shown;
  const [cls, text] = !json ? ["fail", "No .json — can't upload without a title"]
    : json.youtube ? ["ok", `On YouTube (${json.youtube.privacy})`]
    : ["busy", "Not uploaded yet"];
  $("ytDialogStatus").className = cls;
  $("ytDialogStatus").textContent = text;
  $("ytDialogYoutube").hidden = !json?.youtube;
  if (json?.youtube) $("ytDialogYoutube").href = `https://youtu.be/${json.youtube.video_id}`;

  const button = $("ytDialogUpload");
  button.hidden = !json || !!json.youtube;
  button.disabled = !!uploading;
  button.textContent = uploading?.id === id ? uploading.text
    : uploading ? "Another video is uploading…"
    : "Upload to YouTube (private)";
}

async function uploadShown() {
  const { dir, id, json } = shown;
  uploading = { id, text: "Uploading… 0%" };
  $("ytDialogUploadNote").className = "note";
  $("ytDialogUploadNote").textContent = "";
  showStatus();
  try {
    const youtube = await upload(dir, id, (p) => {
      uploading.text = `Uploading… ${Math.round(p * 100)}%`;
      if (shown?.id === id) showStatus();
    });
    json.youtube = youtube;
    onUploaded();
  } catch (e) {
    console.error(`Upload of reel ${id}`, e);
    if (shown?.id === id) {
      $("ytDialogUploadNote").className = "note fail";
      $("ytDialogUploadNote").textContent = e.message;
    }
  } finally {
    uploading = null;
    if (shown) showStatus();
  }
}

function closeDetails() {
  const video = $("ytDialogVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (dialogUrl) URL.revokeObjectURL(dialogUrl);
  dialogUrl = null;
  shown = null;
}

export function initGallery(options) {
  ({ upload, onUploaded } = options);
  const dialog = $("ytDialog");
  $("ytDialogUpload").addEventListener("click", uploadShown);
  $("ytDialogClose").addEventListener("click", () => dialog.close());
  // Clicking the backdrop closes it too. The dialog has no padding (its content is in
  // .dialog-body), so a click whose target is the dialog itself is on the backdrop.
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  dialog.addEventListener("close", closeDetails);
}
