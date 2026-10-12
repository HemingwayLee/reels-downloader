// The Downloads folder the user picked, so reels can be looked up on disk.
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

/** Ask the user for their Downloads folder and remember it. Returns null if cancelled. */
export async function pickFolder() {
  let handle;
  try {
    handle = await showDirectoryPicker({ id: "downloads", startIn: "downloads", mode: "read" });
  } catch (e) {
    if (e.name === "AbortError") return null;
    throw e;
  }
  await idb("readwrite", (s) => s.put(handle, KEY));
  return handle;
}

/**
 * True if read access to `handle` is granted. With `ask`, prompts for it, which only works
 * during a user gesture (e.g. right after the Run click).
 */
export async function canRead(handle, ask = false) {
  const opts = { mode: "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return ask && (await handle.requestPermission(opts)) === "granted";
}

/**
 * True if `path` (like "reels/<page>/<id>.mp4", relative to the Downloads folder) exists.
 * Picking the "reels" folder itself works too. Chrome writes to a .crdownload file and
 * renames it when done, so a file under the final name is a finished download.
 */
export async function existsOnDisk(handle, path) {
  const parts = path.split("/");
  if (handle.name === parts[0]) parts.shift();
  try {
    let dir = handle;
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    await dir.getFileHandle(parts.at(-1));
    return true;
  } catch (e) {
    if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return false;
    throw e;
  }
}
