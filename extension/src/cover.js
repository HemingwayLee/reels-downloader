// Facebook re-encodes an auto cover as its own file, so the cover and first frame are
// compared by content: auto covers score ~0.99 SSIM, designed covers below ~0.1.
const SAME_IMAGE_SSIM = 0.9;
const SIZE = 256;

/**
 * True if the reel's cover image isn't just the video's first frame. Uses the page's
 * first-frame image when there is one, otherwise decodes the first frame of the video.
 */
export async function isCustomCover(coverUrl, firstFrameUrl, videoUrl) {
  const [cover, first] = await Promise.all([
    imageGray(coverUrl),
    firstFrameUrl ? imageGray(firstFrameUrl) : videoFirstFrameGray(videoUrl),
  ]);
  return ssim(cover, first) < SAME_IMAGE_SSIM;
}

/** Fetch an image and return its luma at SIZE x SIZE. */
async function imageGray(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image returned HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), {
    resizeWidth: SIZE,
    resizeHeight: SIZE,
    resizeQuality: "high",
  });
  try {
    return toGray(bitmap);
  } finally {
    bitmap.close();
  }
}

/**
 * Load just the start of a video and return its first frame's luma at SIZE x SIZE.
 * Facebook's video CDN allows cross-origin reads, so the canvas isn't tainted.
 */
async function videoFirstFrameGray(url) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out loading the video")), 30_000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not load the video for its first frame"));
      };
      video.src = url;
    });
    return toGray(video);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** Draw `source` at SIZE x SIZE and return its luma (BT.601) values. */
function toGray(source) {
  const ctx = new OffscreenCanvas(SIZE, SIZE).getContext("2d");
  ctx.drawImage(source, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const gray = new Float64Array(SIZE * SIZE);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

/** Mean SSIM over 8x8 windows with a stride of 4, like ffmpeg's ssim filter. */
function ssim(a, b) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const W = 8;
  let total = 0;
  let windows = 0;
  for (let y = 0; y + W <= SIZE; y += 4) {
    for (let x = 0; x + W <= SIZE; x += 4) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let dy = 0; dy < W; dy++) {
        for (let dx = 0; dx < W; dx++) {
          const i = (y + dy) * SIZE + x + dx;
          sa += a[i];
          sb += b[i];
          saa += a[i] * a[i];
          sbb += b[i] * b[i];
          sab += a[i] * b[i];
        }
      }
      const n = W * W;
      const ma = sa / n, mb = sb / n;
      const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) /
        ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return total / windows;
}
