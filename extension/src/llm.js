import { CreateExtensionServiceWorkerMLCEngine } from "@mlc-ai/web-llm";
import * as OpenCC from "opencc-js";

// Titles are written by a model downloaded in WebLLM Model Manager, another extension
// (see ~/Desktop/code/projects/demo-webllm). It runs the model and streams answers back,
// so this extension downloads nothing. Its ID is fixed by the "key" in its manifest.
export const MANAGER_ID = "kpfphjjelobankiknfkcigkcfnnhcddk";

// YouTube's title limit, which the old pipeline uploaded to.
const MAX_TITLE_LENGTH = 100;

const toTaiwan = OpenCC.Converter({ from: "cn", to: "twp" });
const toSimplified = OpenCC.Converter({ from: "twp", to: "cn" });

/** The model IDs downloaded in the manager. Throws if the manager isn't installed. */
export async function listModels() {
  const res = await chrome.runtime.sendMessage(MANAGER_ID, { type: "listModels" });
  if (res?.error) throw new Error(res.error);
  return res?.models ?? [];
}

let engine = null;
let loadedModel = null;

/** Connect to the manager and load `modelId` (once; later calls reuse it). */
export async function loadModel(modelId, onProgress) {
  if (engine && loadedModel === modelId) return;
  engine = await CreateExtensionServiceWorkerMLCEngine(modelId, {
    extensionId: MANAGER_ID,
    initProgressCallback: (r) => onProgress?.(r.text),
    onDisconnect: () => {
      engine = null;
      loadedModel = null;
    },
  });
  loadedModel = modelId;
}

/** Summarize a reel caption into a short title, in the caption's language. */
export async function titleFor(caption) {
  if (!engine) throw new Error("No model loaded");
  const reply = await engine.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You write titles for short videos. Summarize the video's caption into one short, " +
          "natural title. Write it in the same language and script as the caption: a caption " +
          "in Traditional Chinese gets a Traditional Chinese title. Keep Chinese titles under " +
          "30 characters and other titles under 12 words. Reply with the title only: no " +
          "quotes, hashtags, emoji or explanation.",
      },
      { role: "user", content: caption },
    ],
    temperature: 0.3,
    max_tokens: 80,
    // Qwen3 models think out loud first unless told not to.
    ...(loadedModel.startsWith("Qwen3") && { extra_body: { enable_thinking: false } }),
  });
  let title = (reply.choices[0]?.message?.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim()
    .split("\n")[0]
    .replace(/^(title|標題|标题)\s*[:：]\s*/i, "")
    .replace(/^["'「『“《]+|["'」』”》]+$/g, "")
    .trim();
  // Small models often drift into Simplified Chinese; match a Traditional caption.
  if (toSimplified(caption) !== caption) title = toTaiwan(title);
  return title.slice(0, MAX_TITLE_LENGTH) || null;
}
