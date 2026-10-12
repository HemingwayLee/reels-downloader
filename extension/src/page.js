// Functions run inside the Facebook tab with chrome.scripting.executeScript. They must be
// self-contained (no outer references): Chrome serializes each one into the page. Running
// there makes requests same-origin with the user's Facebook login, which Facebook needs to
// include the video data (it leaves it out of cross-site requests).

/**
 * Scroll the reels tab until at least `min` reel IDs have been seen (or the page stops
 * loading more), and return every ID seen so far, newest first.
 */
export async function collectReelIds(min, reset) {
  if (reset || !window.__reelsDownloader) window.__reelsDownloader = { ids: [] };
  const state = window.__reelsDownloader;
  const seen = new Set(state.ids);
  const harvest = () => {
    for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
      const m = a.getAttribute("href").match(/\/reel\/(\d+)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        state.ids.push(m[1]);
      }
    }
  };
  harvest();
  // Stop after this many scrolls in a row without new reels appearing.
  let stale = 0;
  while (state.ids.length < min && stale < 6) {
    const before = state.ids.length;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 1500));
    harvest();
    stale = state.ids.length === before ? stale + 1 : 0;
  }
  return state.ids;
}

/**
 * Fetch a reel's page and pull out its video and cover URLs.
 * Returns {video, caption, firstFrame, cover} (all but video may be null) or {error}.
 */
export async function fetchReelInfo(id) {
  // The page embeds its data as JSON in <script type="application/json"> tags, and the
  // layout differs between logged-in and logged-out visitors (and changes over time). So
  // find the objects that are this reel ({"id":"<id>",...}) and search inward from them
  // for the fields below. The page also preloads the next few reels; their objects have
  // other IDs and are never searched into.
  function findReel(html) {
    const nodes = [];
    // The objects enclosing each reel object, closest first. The caption can live on the
    // post (story) that wraps the video rather than inside the video object.
    const ancestors = [];
    const walk = (v, path) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, path));
      if (v.id === id || v.videoId === id) {
        nodes.push(v);
        ancestors.push(...path.toReversed());
      }
      path.push(v);
      for (const k in v) walk(v[k], path);
      path.pop();
    };
    for (const [, text] of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
      if (!text.includes(id)) continue;
      try {
        walk(JSON.parse(text), []);
      } catch {
        // Not every script tag is guaranteed to be valid JSON; skip it.
      }
    }
    // Breadth-first from the reel's objects, so the closest match wins.
    const nearest = (pick) => {
      for (const node of nodes) {
        const queue = [node];
        for (let i = 0; i < queue.length; i++) {
          const found = pick(queue[i]);
          if (found) return found;
          for (const child of Object.values(queue[i])) {
            if (!child || typeof child !== "object") continue;
            if (child.__typename === "Video" && child.id && child.id !== id) continue;
            queue.push(child);
          }
        }
      }
      return null;
    };
    const progressive = (list, quality) => Array.isArray(list)
      ? list.find((p) => p?.progressive_url && (!quality || p.metadata?.quality === quality))?.progressive_url
      : null;
    // Progressive MP4s (video and audio in one file), HD first.
    const video = nearest((v) =>
      v.browser_native_hd_url || v.playable_url_quality_hd || progressive(v.progressive_urls, "HD") ||
      v.browser_native_sd_url || v.playable_url || progressive(v.progressive_urls));
    // The caption is the reel's post text, a {"message":{"text":...}} on the post. Where
    // the post sits differs by layout: under the video as "creation_story" (logged out),
    // or wrapping the video (logged in), where the video's own "creation_story" can have
    // "message":null even though the post has a caption. So take the first non-empty text,
    // searching inside the reel first and then the objects around it, closest first.
    const messageText = (v) => {
      const texts = [
        v.creation_story?.message?.text,
        v.creation_story?.comet_sections?.message?.story?.message?.text,
        v.fb_shorts_story?.message?.text,
        v.comet_sections?.message?.story?.message?.text,
        v.message?.text,
        v.savable_description?.text,
      ];
      return texts.find((t) => typeof t === "string" && t.trim());
    };
    // Only the ancestors' own fields are checked, not their other children, which can be
    // the next reels the page preloads.
    const caption = nearest(messageText) ?? ancestors.map(messageText).find(Boolean)
      ?? metaDescription(html);
    return {
      nodes,
      video,
      caption: caption ?? "",
      firstFrame: nearest((v) => typeof v.first_frame_thumbnail === "string" && v.first_frame_thumbnail),
      cover: nearest((v) => v.thumbnailImage?.uri || v.preferred_thumbnail?.image?.uri),
    };
  }

  // Last resort: the og:description meta tag, which holds the caption on some layouts.
  function metaDescription(html) {
    const tag = html.match(/<meta[^>]+property="og:description"[^>]*>/)?.[0];
    const content = tag?.match(/content="([^"]*)"/)?.[1];
    if (!content) return null;
    // Decoded by hand: Facebook's Trusted Types policy can block innerHTML.
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    const text = content.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
      e[0] !== "#" ? named[e.toLowerCase()] ?? m
        : String.fromCodePoint(parseInt(e.slice(e[1] === "x" || e[1] === "X" ? 2 : 1), e[1] === "x" || e[1] === "X" ? 16 : 10)));
    return text.trim() || null;
  }

  try {
    // Facebook sometimes serves a page without the video data (e.g. after many requests
    // in a row), so try once more after a pause before giving up.
    let html, res, reel;
    for (let attempt = 0; attempt < 2 && !reel?.video; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 3000));
      // Facebook only embeds the video data when the request asks for HTML.
      res = await fetch(`/reel/${id}`, { headers: { Accept: "text/html" } });
      if (!res.ok) return { error: `Reel page returned HTTP ${res.status}` };
      html = await res.text();
      reel = findReel(html);
    }
    if (!reel.video) {
      // Describe what the page did contain, to tell a changed page layout from a login
      // wall or a stripped-down page.
      const urlKeys = new Set();
      const collect = (v, depth) => {
        if (!v || typeof v !== "object" || depth > 12 || urlKeys.size >= 15) return;
        for (const k in v) {
          if (typeof v[k] === "string" && v[k].startsWith("https://")) urlKeys.add(k);
          else collect(v[k], depth + 1);
        }
      };
      reel.nodes.forEach((n) => collect(n, 0));
      const path = new URL(res.url).pathname;
      return {
        error: `Video URL not found on the reel page (${(html.length / 1e6).toFixed(1)} MB` +
          (path !== `/reel/${id}` ? `, redirected to ${path}` : "") +
          `, ${reel.nodes.length} objects for the reel, URL fields: ${[...urlKeys].join(" ") || "none"})`,
      };
    }
    return { video: reel.video, caption: reel.caption, firstFrame: reel.firstFrame, cover: reel.cover };
  } catch (e) {
    return { error: String(e) };
  }
}
