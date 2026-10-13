import { isCustomCover } from "./cover.js";
import { canAccess, existsOnDisk, pickFolder, savedFolder } from "./folder.js";
import { $, activeTab, addRow, reelsPage } from "./ui.js";
import { initUploadTab, refreshUploadTab } from "./upload.js";
import { listModels, loadModel, MANAGER_ID, titleFor } from "./llm.js";
import { collectReelIds, fetchReelInfo } from "./page.js";

const form = $("form");
const runButton = $("run");

/** The running job ({stop}), or null when idle. */
let job = null;

async function refreshPage() {
  if (job) return;
  const page = reelsPage((await activeTab())?.url ?? "");
  $("page").textContent = page
    ? `Page: ${page} — saves to Downloads/reels/${page}/`
    : "Open a Facebook page's Reels tab (facebook.com/<page>/reels/) in this tab.";
  runButton.disabled = !page;
}

/** Run one of page.js's functions in the tab and return its result. */
async function inTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

/**
 * True if `reels/<page>/<id>.mp4` is already saved. With a readable Downloads folder,
 * looks on disk; otherwise falls back to Chrome's download history, which forgets
 * everything when the history is cleared.
 */
async function alreadyDownloaded(filename, folder) {
  if (folder) return existsOnDisk(folder, filename);
  const sep = "[/\\\\]";
  const pattern = filename.split("/").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const found = await chrome.downloads.search({
    filenameRegex: `${sep}${pattern.join(sep)}$`,
    state: "complete",
    exists: true,
  });
  return found.length > 0;
}

/** Download `url` to `filename` (relative to the Downloads folder) and wait for it to finish. */
async function download(url, filename, conflictAction = "uniquify") {
  const id = await chrome.downloads.download({ url, filename, conflictAction, saveAs: false });
  return new Promise((resolve, reject) => {
    const settle = (state, error) => {
      if (state === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (state === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`Download interrupted (${error ?? "unknown error"})`));
      }
    };
    const listener = (delta) => {
      if (delta.id === id && delta.state) settle(delta.state.current, delta.error?.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    // In case it finished before the listener was added.
    chrome.downloads.search({ id }).then(([item]) => item && settle(item.state, item.error));
  });
}

/** Save `data` as a JSON file (relative to the Downloads folder), replacing any old one. */
async function saveJson(data, filename) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    await download(url, filename, "overwrite");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fill the model picker with the models downloaded in WebLLM Model Manager. */
async function refreshModels() {
  const select = $("model");
  let models = [];
  let note = "";
  try {
    models = await listModels();
    if (!models.length) note = "No models downloaded in WebLLM Model Manager yet.";
  } catch {
    // sendMessage fails when no extension with that ID is installed.
    note = `WebLLM Model Manager (${MANAGER_ID}) isn't installed or enabled.`;
  }
  const { model: saved } = await chrome.storage.local.get("model");
  const chosen = models.includes(saved) ? saved
    : models.find((m) => /qwen/i.test(m)) ?? models[0];
  select.replaceChildren(...models.map((m) => new Option(m, m, false, m === chosen)));
  select.disabled = !models.length || !$("saveJson").checked;
  $("modelNote").textContent = note && `${note} Titles will be left empty.`;
}

/** Show the chosen Downloads folder and whether it can be read. */
async function refreshFolder() {
  const handle = await savedFolder();
  $("folder").textContent = handle ? handle.name : "Not chosen";
  let note = "";
  if (!handle) {
    note = "Pick your Downloads folder so reels already on disk are skipped, or a folder of "
      + "videos to see and upload in the YouTube tab. Until then, only Chrome's download "
      + "history is checked.";
  } else if (!(await canAccess(handle))) {
    note = "Chrome will ask for access to this folder again when you press Run or Upload.";
  }
  $("folderNote").textContent = note;
}

async function runJob(tabId, page, count, skipCustom, saveCaptions, model, folder) {
  const current = { stop: false };
  job = current;
  runButton.textContent = "Stop";
  runButton.classList.add("stop");
  $("log").replaceChildren();

  let downloaded = 0, skipped = 0, failed = 0;
  let note = "";
  // Set when the model can't be loaded, so later reels don't try again.
  let modelError = model ? null : "no model selected";
  const summarize = (status) => {
    const parts = [`Downloaded ${downloaded} of ${count}`];
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    $("summary").textContent = `${status} ${parts.join(", ")}${note}`;
  };

  try {
    summarize("Scrolling the reels tab…");
    let ids = await inTab(tabId, collectReelIds, [count, true]);
    if (!ids.length) throw new Error("No reels found on this page.");
    // Newest first; skipped and failed reels don't count, so keep going down the page
    // until `count` reels are downloaded or the page runs out.
    for (let i = 0; downloaded < count && !current.stop; i++) {
      if (reelsPage((await chrome.tabs.get(tabId)).url) !== page) {
        throw new Error("The tab left the reels page.");
      }
      if (i >= ids.length) {
        summarize("Scrolling for more reels…");
        const more = await inTab(tabId, collectReelIds, [ids.length + 12, false]);
        if (more.length === ids.length) {
          note = " — the page has no more reels.";
          break;
        }
        ids = more;
      }
      const id = ids[i];
      const filename = `reels/${page}/${id}.mp4`;
      const set = addRow($("log"), id);
      summarize("Running…");
      try {
        set("busy", "checking…");
        if (await alreadyDownloaded(filename, folder)) {
          set("skip", "already downloaded");
          skipped++;
          continue;
        }
        const info = await inTab(tabId, fetchReelInfo, [id]);
        if (info.error) throw new Error(info.error);
        if (skipCustom) {
          if (!info.cover) {
            set("skip", "cover image not found");
            skipped++;
            continue;
          }
          if (!info.firstFrame) set("busy", "checking cover against the video…");
          if (await isCustomCover(info.cover, info.firstFrame, info.video)) {
            set("skip", "custom cover");
            skipped++;
            continue;
          }
        }
        set("busy", "downloading…");
        await download(info.video, filename);
        downloaded++;
        if (!saveCaptions) {
          set("ok", "downloaded");
          continue;
        }

        // Save the caption, with a title summarized from it, as <id>.json next to the video.
        const description = (info.caption ?? "").trim();
        let title = null;
        let titleNote = "";
        if (!description) {
          titleNote = "no caption";
        } else if (modelError) {
          titleNote = `no title: ${modelError}`;
        } else {
          try {
            set("busy", "loading the title model…");
            await loadModel(model, (text) => set("busy", text));
            set("busy", "writing the title…");
            title = await titleFor(description);
          } catch (e) {
            console.error(`Title for reel ${id}`, e);
            titleNote = `no title: ${e.message}`;
            // A model that won't load won't load for the next reel either.
            if (/load|reach|connect|downloaded/i.test(e.message)) modelError = e.message;
          }
        }
        await saveJson(
          { url: `https://www.facebook.com/reel/${id}`, title, description },
          `reels/${page}/${id}.json`,
        );
        set("ok", `downloaded — ${title ? `“${title}”` : titleNote}`);
      } catch (e) {
        console.error(`Reel ${id}`, e);
        set("fail", `failed: ${e.message}`);
        failed++;
      }
    }
    summarize(current.stop ? "Stopped." : "Done.");
  } catch (e) {
    console.error(e);
    note = ` — ${e.message}`;
    summarize("Failed.");
  } finally {
    job = null;
    runButton.textContent = "Run";
    runButton.classList.remove("stop");
    runButton.disabled = false;
    refreshPage();
    refreshModels();
    refreshFolder();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (job) {
    job.stop = true;
    runButton.disabled = true;
    runButton.textContent = "Stopping…";
    return;
  }
  // Ask for folder access first: the prompt needs the Run click's user gesture.
  let folder = await savedFolder();
  if (folder && !(await canAccess(folder, true).catch(() => false))) folder = null;
  refreshFolder();
  const tab = await activeTab();
  const page = reelsPage(tab?.url ?? "");
  if (!page) return refreshPage();
  const model = $("model").value || null;
  runJob(tab.id, page, Number($("count").value), $("skipCustom").checked, $("saveJson").checked,
    model, folder);
});

$("pickFolder").addEventListener("click", async () => {
  try {
    await pickFolder();
  } catch (e) {
    console.error(e);
    $("folderNote").textContent = `Couldn't open the folder: ${e.message}`;
    return;
  }
  refreshFolder();
  refreshUploadTab();
});

// Tabs: Download and YouTube. The last one used is remembered.
function showTab(name) {
  for (const button of document.querySelectorAll(".tab")) {
    const active = button.dataset.tab === name;
    button.classList.toggle("active", active);
    $(`tab-${button.dataset.tab}`).hidden = !active;
  }
  chrome.storage.local.set({ tab: name });
  if (name === "youtube") refreshUploadTab();
}
for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}
chrome.storage.local.get("tab").then(({ tab }) => showTab(tab === "youtube" ? "youtube" : "download"));
initUploadTab();

$("saveJson").addEventListener("change", refreshModels);
$("model").addEventListener("change", () => chrome.storage.local.set({ model: $("model").value }));

// The YouTube tab shows reels/<page>/ for the page open in this tab, so refresh it too.
const onTabChange = () => {
  refreshPage();
  if (!$("tab-youtube").hidden) refreshUploadTab();
};
chrome.tabs.onActivated.addListener(onTabChange);
chrome.tabs.onUpdated.addListener((_tabId, change) => change.url && onTabChange());
refreshPage();
refreshModels();
refreshFolder();
