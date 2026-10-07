"""Summarize reel captions with IDEA-CCNL's Randeng-Pegasus-238M, output in Traditional Chinese.

The model is trained on Simplified Chinese, so captions are converted to Simplified on
the way in and the summary back to Taiwan-style Traditional Chinese on the way out.
"""

import re
import threading
import unicodedata

MODEL_ID = "IDEA-CCNL/Randeng-Pegasus-238M-Summary-Chinese"
MAX_INPUT_TOKENS = 1024

# The model needs IDEA-CCNL's own tokenizer (tokenizers_pegasus.py in the model repo),
# which imports their training repo and breaks on current transformers. It is BERT
# WordPiece with jieba word segmentation in front and a few renamed special tokens,
# reimplemented below.
_SPECIAL_RENAMES = {
    "[PAD]": "<pad>", "[unused1]": "</s>", "[UNK]": "<unk>",
    "[unused2]": "<mask_1>", "[unused3]": "<mask_2>",
}
# Punctuation the original decoder joins without a following space.
_NO_SPACE_AFTER = re.compile(
    "([%s]) " % re.escape(
        "＂＃＄％＆＇（）＊＋，－／：；＜＝＞＠［＼］＾＿｀｛｜｝～｟｠｢｣､　、〃〈〉《》「」『』【】〔〕"
        "〖〗〘〙〚〛〜〝〞〟〰〾〿–—‘’‛“”„‟…‧﹏﹑﹔·！？｡。+-/={(<["
    )
)


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in (
        (0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x20000, 0x2A6DF), (0x2A700, 0x2B73F),
        (0x2B740, 0x2B81F), (0x2B820, 0x2CEAF), (0xF900, 0xFAFF), (0x2F800, 0x2FA1F),
    ))


def _is_punctuation(ch: str) -> bool:
    cp = ord(ch)
    return (33 <= cp <= 47 or 58 <= cp <= 64 or 91 <= cp <= 96 or 123 <= cp <= 126
            or unicodedata.category(ch).startswith("P"))


class _Tokenizer:
    def __init__(self, vocab_path: str):
        with open(vocab_path, encoding="utf-8") as f:
            tokens = [_SPECIAL_RENAMES.get(t, t) for t in f.read().splitlines()]
        self.vocab = {t: i for i, t in enumerate(tokens)}
        self.tokens = tokens
        self.eos_id, self.unk_id = self.vocab["</s>"], self.vocab["<unk>"]
        # Special tokens the original decoder leaves out (it keeps <mask_1>).
        self.skip_ids = {self.vocab[t] for t in
                         ("<pad>", "</s>", "<unk>", "<mask_2>", "[CLS]", "[SEP]")}

    def _basic_split(self, text: str) -> list[str]:
        """BERT's basic tokenizer: lowercase, strip accents, split CJK chars and punctuation."""
        out: list[str] = []
        for ch in unicodedata.normalize("NFD", text.lower()):
            if ch in " \t\n\r" or unicodedata.category(ch) == "Zs":
                out.append(" ")
            elif unicodedata.category(ch) == "Mn" or unicodedata.category(ch).startswith("C"):
                continue  # accents and control characters are dropped
            elif _is_cjk(ch) or _is_punctuation(ch):
                out.append(f" {ch} ")
            else:
                out.append(ch)
        return "".join(out).split()

    def _wordpiece(self, word: str) -> list[int]:
        if len(word) > 100:
            return [self.unk_id]
        ids, start = [], 0
        while start < len(word):
            for end in range(len(word), start, -1):
                piece = word[start:end] if start == 0 else "##" + word[start:end]
                if piece in self.vocab:
                    ids.append(self.vocab[piece])
                    start = end
                    break
            else:
                return [self.unk_id]
        return ids

    def encode(self, text: str) -> list[int]:
        import jieba

        ids: list[int] = []
        for word in jieba.cut(text, HMM=False):
            if word in self.vocab:
                ids.append(self.vocab[word])
            else:
                for token in self._basic_split(word):
                    ids += self._wordpiece(token)
        return ids[:MAX_INPUT_TOKENS - 1] + [self.eos_id]

    def decode(self, ids: list[int]) -> str:
        tokens = [self.tokens[i] for i in ids if i not in self.skip_ids]
        text = ""
        for i, token in enumerate(tokens):
            if token.startswith("##"):
                text += token[2:]
            elif len(token) == 1 and _is_cjk(token):
                text += token
            elif len(token) == 1 and _is_punctuation(token):
                text += token + " "
            elif i > 0 and _is_cjk(text[-1]):
                text += token
            else:
                text += " " + token
        text = re.sub(" +", " ", text)
        text = _NO_SPACE_AFTER.sub(r"\1", text)
        return re.sub(r"(\d\.) (\d)", r"\1\2", text).strip()


# Download jobs run in parallel threads; load the model once and run one generation at a time.
_lock = threading.Lock()
_loaded = None


def _load():
    global _loaded
    if _loaded is None:
        # Imported lazily so the API starts without paying torch's import cost.
        import opencc
        from huggingface_hub import hf_hub_download
        from transformers import PegasusForConditionalGeneration

        model = PegasusForConditionalGeneration.from_pretrained(MODEL_ID).eval()
        tokenizer = _Tokenizer(hf_hub_download(MODEL_ID, "vocab.txt"))
        _loaded = (model, tokenizer, opencc.OpenCC("t2s"), opencc.OpenCC("s2twp"))
    return _loaded


def summarize(text: str) -> str:
    import torch

    with _lock:
        model, tokenizer, to_simplified, to_traditional = _load()
        input_ids = torch.tensor([tokenizer.encode(to_simplified.convert(text))])
        with torch.inference_mode():
            output = model.generate(
                input_ids,
                attention_mask=torch.ones_like(input_ids),
                # Greedy decoding gives headline-short summaries ("牛肉湯！"); beam search
                # with a floor of ~30% of the input keeps the key details.
                num_beams=4,
                min_new_tokens=max(4, int(input_ids.shape[1] * 0.3)),
            )
        summary = to_traditional.convert(tokenizer.decode(output[0].tolist()))
        # OpenCC writes the formal 臺 (臺灣, 臺南); everyday Taiwanese text uses 台.
        return summary.replace("臺", "台")
