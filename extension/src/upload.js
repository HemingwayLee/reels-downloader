// The YouTube tab: show and upload the videos in the folder chosen at the top of the side panel (or
// its reels/<page>/ for the Facebook page open in this tab) to YouTube, with the title and
// description from each reel's .json. The video ID is written back into the
// .json ({"youtube": {...}}) so a reel is never uploaded twice.

import { canAccess, listFiles, readJson, reelsDir, savedFolder, writeJson } from "./folder.js";
import { clearGallery, initGallery, renderGallery } from "./gallery.js";
import { $, activeTab, reelsPage } from "./ui.js";
import {
  account, isLimitError, redirectUri, setClient, signIn, signOut, uploadVideo, youtubeMetadata,
} from "./youtube.js";

// Uploads start private; change the visibility in YouTube Studio when ready.
const PRIVACY = "private";

/** Oldest first: reel IDs grow over time, so sort them as numbers. */
function byReelId(a, b) {
  try {
    const x = BigInt(a), y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

/**
 * The reels in a folder: `items` ({id, json}, oldest first; json is null without a .json)
 * and {pending, uploaded, noJson}, each a list of reel IDs. Reels without a .json are left
 * out of `pending`: their title and description are unknown.
 */
async function scan(dir) {
  const files = await listFiles(dir);
  const result = { items: [], pending: [], uploaded: [], noJson: [] };
  const ids = [...files].filter((n) => n.endsWith(".mp4")).map((n) => n.slice(0, -4)).sort(byReelId);
  for (const id of ids) {
    const json = files.has(`${id}.json`) ? await readJson(dir, `${id}.json`).catch(() => null) : null;
    result.items.push({ id, json });
    if (!json) result.noJson.push(id);
    else (json.youtube ? result.uploaded : result.pending).push(id);
  }
  return result;
}

/**
 * The folder whose videos this tab shows and uploads, as {dir, label}: the folder chosen at
 * the top if it holds .mp4 files, else its reels/<page>/ for the Facebook page open in this
 * tab. Null (with a note shown, or nothing if no folder is chosen) if there is none.
 */
async function sourceFolder({ ask = false } = {}) {
  const note = (text, needsAccess = false) => {
    $("ytCounts").textContent = text;
    $("ytAllow").hidden = !needsAccess;
  };
  note("");
  const handle = await savedFolder();
  if (!handle) return null;
  if (!(await canAccess(handle, ask).catch(() => false))) {
    note(`Chrome needs your permission again to read ${handle.name}.`, true);
    return null;
  }
  if ([...(await listFiles(handle))].some((n) => n.endsWith(".mp4"))) {
    return { dir: handle, label: handle.name };
  }
  const page = reelsPage((await activeTab())?.url ?? "");
  const reels = await reelsDir(handle);
  if (page && reels) {
    try {
      return { dir: await reels.getDirectoryHandle(page), label: `reels/${page}` };
    } catch (e) {
      if (e.name !== "NotFoundError") throw e;
    }
  }
  note(page
    ? `No reels of ${page} in ${handle.name} yet.`
    : `No videos in ${handle.name}. Choose a folder of .mp4 files at the top, or open a `
      + "Facebook page's Reels tab to see its downloaded reels.");
  return null;
}

async function refreshAccount() {
  const { clientId, hasSecret, channel, signedIn } = await account();
  $("ytClientId").value = clientId;
  // The saved secret is never shown again; the placeholder says whether there is one.
  $("ytClientSecret").value = "";
  $("ytClientSecret").placeholder = hasSecret ? "Saved — type to replace" : "GOCSPX-…";
  $("ytChannel").textContent = signedIn ? `Signed in · ${channel ?? "your channel"}` : "Not signed in";
  $("ytAccount").classList.toggle("signed-in", signedIn);
  $("ytAccount").classList.toggle("signed-out", !signedIn);
  $("ytSignIn").hidden = signedIn;
  $("ytSignOut").hidden = !signedIn;
  // The Sign in button is in the setup section, so keep it open while signed out.
  if (!signedIn) $("ytSetup").open = true;
}

/** Refresh the account, the folder's counts and its thumbnails. */
export async function refreshUploadTab() {
  await refreshAccount();
  const source = await sourceFolder();
  $("ytFolder").textContent = source ? `Videos in ${source.label}` : "";
  if (!source) return clearGallery();
  const { items, pending, uploaded, noJson } = await scan(source.dir);
  renderGallery(source.dir, items, source.label);
  if (!items.length) {
    $("ytCounts").textContent = "No .mp4 files in this folder.";
    return;
  }
  const parts = [`${pending.length} to upload`, `${uploaded.length} already on YouTube`];
  if (noJson.length) parts.push(`${noJson.length} without a .json`);
  $("ytCounts").textContent = parts.join(" · ");
}

/**
 * Upload reel `id` from `dir` as a private video with the title and description from its
 * .json, record it in the .json and return that record ({video_id, privacy, uploaded_at}).
 */
async function uploadReel(dir, id, onProgress) {
  if (!(await account()).signedIn) throw new Error("Sign in to YouTube first (at the top of this tab).");
  // Read again right before uploading, in case it changed since the folder was listed.
  const json = await readJson(dir, `${id}.json`);
  if (!json) throw new Error("This video has no .json, so it has no title or description.");
  if (json.youtube) return json.youtube;
  const { title, description } = youtubeMetadata(json, id);
  const file = await (await dir.getFileHandle(`${id}.mp4`)).getFile();
  let videoId;
  try {
    videoId = await uploadVideo(file, { title, description, privacy: PRIVACY }, onProgress);
  } catch (e) {
    if (isLimitError(e)) throw new Error(`YouTube won't take more uploads right now (daily limit): ${e.message}`);
    throw e;
  }
  json.youtube = { video_id: videoId, privacy: PRIVACY, uploaded_at: new Date().toISOString() };
  await writeJson(dir, `${id}.json`, json);
  return json.youtube;
}

export function initUploadTab() {
  initGallery({ upload: uploadReel, onUploaded: refreshUploadTab });
  $("ytRedirect").value = redirectUri();

  const saveClient = () => setClient($("ytClientId").value.trim(), $("ytClientSecret").value.trim());
  for (const id of ["ytClientId", "ytClientSecret"]) {
    $(id).addEventListener("change", async () => {
      await saveClient();
      refreshAccount();
    });
  }

  $("ytSignIn").addEventListener("click", async () => {
    const button = $("ytSignIn");
    // One sign-in at a time: Chrome refuses a second sign-in window while one is open.
    button.disabled = true;
    button.textContent = "Signing in…";
    $("ytNote").textContent = "";
    try {
      await saveClient();
      await signIn();
    } catch (e) {
      console.error(e);
      $("ytNote").textContent = e.message;
    } finally {
      button.disabled = false;
      button.textContent = "Sign in with Google";
    }
    refreshAccount();
  });

  $("ytSignOut").addEventListener("click", async () => {
    await signOut();
    refreshAccount();
  });

  $("ytCopy").addEventListener("click", () => {
    navigator.clipboard.writeText(redirectUri()).then(() => {
      $("ytCopy").textContent = "Copied";
      setTimeout(() => ($("ytCopy").textContent = "Copy"), 1500);
    });
  });

  // Folder access can lapse after a restart; asking needs a click.
  $("ytAllow").addEventListener("click", async () => {
    await sourceFolder({ ask: true });
    refreshUploadTab();
  });
}
