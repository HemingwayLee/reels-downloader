// The folder the user picked at the top of the side panel: the Downloads folder (so reels
// can be looked up on disk) or a folder of videos. The YouTube tab shows and uploads its
// videos, writing the YouTube video ID back into each reel's .json.
// Extensions can't read the disk directly; a directory handle from showDirectoryPicker
// is the only way in. It's kept in IndexedDB (handles can't go in chrome.storage).

const DB = "reels-downloader";
const STORE = "handles";
const KEY = "downloads";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, op) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** The saved folder handle, or null. */
export async function savedFolder() {
  try {
    return (await idb("readonly", (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

/** Ask the user for a folder and remember it. Returns null if cancelled. */
export async function pickFolder() {
  let handle;
  try {
    handle = await showDirectoryPicker({ id: "downloads", startIn: "downloads", mode: "readwrite" });
  } catch (e) {
    if (e.name === "AbortError") return null;
    throw e;
  }
  await idb("readwrite", (s) => s.put(handle, KEY));
  return handle;
}

/**
 * True if read/write access to `handle` is granted. With `ask`, prompts for it, which only
 * works during a user gesture (e.g. right after a button click).
 */
export async function canAccess(handle, ask = false) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return ask && (await handle.requestPermission(opts)) === "granted";
}

const isNotFound = (e) => e.name === "NotFoundError" || e.name === "TypeMismatchError";

/**
 * True if `path` (like "reels/<page>/<id>.mp4", relative to the Downloads folder) exists.
 * Picking the "reels" or "<page>" folder itself works too. Chrome writes to a .crdownload
 * file and renames it when done, so a file under the final name is a finished download.
 */
export async function existsOnDisk(handle, path) {
  let parts = path.split("/");
  const at = parts.slice(0, -1).lastIndexOf(handle.name);
  if (at >= 0) parts = parts.slice(at + 1);
  try {
    let dir = handle;
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    await dir.getFileHandle(parts.at(-1));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** The "reels" folder inside the picked folder (or the picked folder itself), or null. */
export async function reelsDir(handle) {
  if (handle.name === "reels") return handle;
  try {
    return await handle.getDirectoryHandle("reels");
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The names of the files in `dir`. */
export async function listFiles(dir) {
  const names = new Set();
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === "file") names.add(name);
  }
  return names;
}

/** The parsed JSON file `name` in `dir`, or null if there is none. */
export async function readJson(dir, name) {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Replace the JSON file `name` in `dir` with `data`. */
export async function writeJson(dir, name, data) {
  const writable = await (await dir.getFileHandle(name)).createWritable();
  await writable.write(`${JSON.stringify(data, null, 2)}\n`);
  await writable.close();
}
