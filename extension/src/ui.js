// Small DOM helpers shared by the side panel's tabs.

export const $ = (id) => document.getElementById(id);

/**
 * The folder name for a Facebook page's reels tab URL, or null if it isn't one.
 * Accepts facebook.com/<page>/reels/ and facebook.com/profile.php?id=<id>&sk=reels_tab.
 */
export function reelsPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "facebook.com" && !u.hostname.endsWith(".facebook.com")) return null;
  let name = null;
  if (u.pathname === "/profile.php") {
    if (u.searchParams.get("sk") === "reels_tab") name = u.searchParams.get("id");
  } else {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && parts[1] === "reels") name = decodeURIComponent(parts[0]);
  }
  return name && name.replace(/[^\p{L}\p{N}._-]/gu, "_");
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Add a row for reel `id` to the top of `list` and return a setter for its status text. */
export function addRow(list, id) {
  const li = document.createElement("li");
  const link = document.createElement("a");
  link.href = `https://www.facebook.com/reel/${id}`;
  link.target = "_blank";
  link.textContent = id;
  const status = document.createElement("span");
  li.append(link, " — ", status);
  list.prepend(li);
  return (cls, text) => {
    status.className = cls;
    status.textContent = text;
  };
}
