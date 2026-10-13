// Upload videos to the user's YouTube channel with the YouTube Data API v3.
//
// Google requires every app that uploads to have its own OAuth client, so the user creates
// one (type "Web application") with this extension's redirect URI and enters its client ID
// and secret. Sign-in is the authorization-code flow (with PKCE) through
// chrome.identity.launchWebAuthFlow, always showing Google's account chooser. The code is
// exchanged for a refresh token, which renews the hour-long access token without asking
// again. Everything is kept in chrome.storage.local, on this computer only.

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  // Only to show which channel is connected.
  "https://www.googleapis.com/auth/youtube.readonly",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TITLE_MAX_CHARS = 100;
const DESCRIPTION_MAX_BYTES = 5000;
const CATEGORY_PEOPLE_AND_BLOGS = "22";
// Renew the token when it has less than this left, so an upload doesn't outlive it.
const TOKEN_MARGIN_MS = 10 * 60 * 1000;

/**
 * The redirect URI to add to the OAuth client's "Authorized redirect URIs", without the
 * trailing "/" chrome.identity.getRedirectURL() adds. Google compares it exactly; Chrome
 * catches the redirect by the https://<extension id>.chromiumapp.org origin either way.
 */
export const redirectUri = () => chrome.identity.getRedirectURL().replace(/\/$/, "");

/** {clientId, hasSecret, channel, signedIn} from storage. */
export async function account() {
  const { ytClientId, ytClientSecret, ytToken, ytChannel } = await chrome.storage.local.get(
    ["ytClientId", "ytClientSecret", "ytToken", "ytChannel"]);
  return {
    clientId: ytClientId ?? "",
    hasSecret: !!ytClientSecret,
    channel: ytChannel ?? null,
    signedIn: !!ytToken?.refreshToken,
  };
}

/** Save the OAuth client. An empty `clientSecret` keeps the saved one. */
export async function setClient(clientId, clientSecret) {
  const { ytClientId, ytClientSecret } = await chrome.storage.local.get(["ytClientId", "ytClientSecret"]);
  const secret = clientSecret || ytClientSecret || "";
  if (clientId === (ytClientId ?? "") && secret === (ytClientSecret ?? "")) return;
  // A token belongs to the client that issued it.
  await chrome.storage.local.remove(["ytToken", "ytChannel"]);
  await chrome.storage.local.set({ ytClientId: clientId, ytClientSecret: secret });
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** POST to Google's token endpoint and store the result. Returns the access token. */
async function requestToken(params, refreshToken) {
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Google sign-in failed: ${data.error_description || data.error || `HTTP ${res.status}`}`);
    e.code = data.error;
    throw e;
  }
  const ytToken = {
    token: data.access_token,
    // Google only sends a refresh token on the first exchange; keep the one we have.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
  await chrome.storage.local.set({ ytToken });
  return ytToken.token;
}

/** Sign in with Google (showing the account chooser) and look up the channel's name. */
export async function signIn() {
  const { ytClientId: clientId, ytClientSecret: clientSecret } =
    await chrome.storage.local.get(["ytClientId", "ytClientSecret"]);
  if (!clientId || !clientSecret) throw new Error("Enter your OAuth client ID and secret first");

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    include_granted_scopes: "true",
    // Offline access for a refresh token. select_account always shows Google's account
    // chooser instead of silently using the browser's current account; consent makes
    // Google return a refresh token even on a repeat sign-in.
    access_type: "offline",
    prompt: "select_account consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (e) {
    // Chrome allows one sign-in window at a time; an earlier one (e.g. showing an error
    // page) may still be open behind another window.
    if (/one web auth flow/i.test(e.message)) {
      throw new Error("A Google sign-in window is already open. Finish or close it, then try again.");
    }
    throw new Error(`Google sign-in was cancelled or failed (${e.message})`);
  }
  const params = new URL(redirect).searchParams;
  if (params.get("error")) throw new Error(`Google sign-in failed (${params.get("error")})`);
  if (params.get("state") !== state) throw new Error("Google sign-in failed (state mismatch); please try again");

  await chrome.storage.local.remove(["ytToken", "ytChannel"]);
  const token = await requestToken({
    grant_type: "authorization_code",
    code: params.get("code"),
    code_verifier: verifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(),
  });
  if (!(await chrome.storage.local.get("ytToken")).ytToken.refreshToken) {
    throw new Error("Google didn't return a refresh token; please sign in again");
  }
  let channel = null;
  try {
    const res = await api(token, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true");
    channel = (await res.json()).items?.[0]?.snippet?.title ?? null;
  } catch (e) {
    console.error("Could not look up the YouTube channel", e);
  }
  await chrome.storage.local.set({ ytChannel: channel });
  return channel;
}

export async function signOut() {
  const { ytToken } = await chrome.storage.local.get("ytToken");
  await chrome.storage.local.remove(["ytToken", "ytChannel"]);
  const token = ytToken?.refreshToken ?? ytToken?.token;
  if (token) {
    // Revoke at Google too, so the app no longer has access to the channel.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      { method: "POST" }).catch((e) => console.error("Could not revoke the token", e));
  }
}

/** A valid access token, renewed with the refresh token when it's about to expire. */
async function accessToken({ renew = false } = {}) {
  const { ytClientId, ytClientSecret, ytToken } =
    await chrome.storage.local.get(["ytClientId", "ytClientSecret", "ytToken"]);
  if (!ytToken?.refreshToken) throw new Error("Sign in to YouTube first");
  if (!renew && ytToken.expiresAt - Date.now() > TOKEN_MARGIN_MS) return ytToken.token;
  try {
    return await requestToken({
      grant_type: "refresh_token",
      refresh_token: ytToken.refreshToken,
      client_id: ytClientId,
      client_secret: ytClientSecret,
    }, ytToken.refreshToken);
  } catch (e) {
    if (e.code !== "invalid_grant") throw e;
    // Revoked, or expired (test-mode apps' refresh tokens last 7 days): sign out.
    await chrome.storage.local.remove(["ytToken", "ytChannel"]);
    throw new Error("Your YouTube sign-in expired or was revoked. Sign in to YouTube first");
  }
}

/** YouTube's error message from a failed response, e.g. "The user has exceeded the number of videos they may upload." */
async function googleError(res) {
  let message = "";
  let reason = "";
  try {
    const { error } = await res.json();
    message = error?.message ?? "";
    reason = error?.errors?.[0]?.reason ?? "";
  } catch {
    // Not JSON.
  }
  const e = new Error(`${message.replace(/<[^>]*>/g, "") || `HTTP ${res.status}`}`);
  e.status = res.status;
  e.reason = reason;
  return e;
}

async function api(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await googleError(res);
  return res;
}

/** True if the error means no more uploads will succeed today (quota or upload limit). */
export const isLimitError = (e) =>
  e.status === 403 && /quota|uploadLimitExceeded|rateLimitExceeded/i.test(`${e.reason} ${e.message}`);

/** A YouTube title: one line, at most 100 characters, without "<" or ">". */
export function youtubeTitle(text, fallback) {
  const title = [...(text ?? "").split(/\s+/).join(" ").replace(/[<>]/g, "")]
    .slice(0, TITLE_MAX_CHARS).join("").trim();
  return title || fallback;
}

/** A YouTube description: at most 5000 bytes, without "<" or ">". */
export function youtubeDescription(text) {
  let description = (text ?? "").replace(/[<>]/g, "");
  const encoder = new TextEncoder();
  while (encoder.encode(description).length > DESCRIPTION_MAX_BYTES) description = description.slice(0, -1);
  return description;
}

/**
 * The YouTube title and description for a reel's .json (null if it has none). Older .json
 * files (from the web app) use "summary"/"text" instead of "title"/"description". Without a
 * title, the first line of the description is used, and without either, `fallbackTitle`.
 */
export function youtubeMetadata(json, fallbackTitle) {
  const description = json?.description ?? json?.text ?? "";
  return {
    title: youtubeTitle(json?.title ?? json?.summary ?? description.split("\n")[0], fallbackTitle),
    description: youtubeDescription(description),
  };
}

/**
 * Upload `file` (a File/Blob of an MP4) and return the new video's ID.
 * `onProgress` gets the fraction uploaded (0–1).
 */
export async function uploadVideo(file, { title, description, privacy }, onProgress) {
  const start = (token) => api(token,
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.type || "video/mp4",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId: CATEGORY_PEOPLE_AND_BLOGS },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      }),
    });
  let token = await accessToken();
  let res;
  try {
    res = await start(token);
  } catch (e) {
    // The token was revoked or expired early; get a new one and try once more.
    if (e.status !== 401) throw e;
    token = await accessToken({ renew: true });
    res = await start(token);
  }
  const session = res.headers.get("Location");
  if (!session) throw new Error("YouTube didn't return an upload URL");

  // XMLHttpRequest rather than fetch, for upload progress.
  const video = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", session);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status >= 200 && xhr.status < 300) res.json().then(resolve, reject);
      else googleError(res).then(reject);
    };
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.send(file);
  });
  return video.id;
}
