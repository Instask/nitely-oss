export const KNOWLEDGE_TOKENIZER_VERSION = "nitely.knowledge-tokenizer.v1";

const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;
const CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_CHARACTER_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface TruncatedKnowledgeText {
  text: string;
  truncated: boolean;
}

/**
 * Canonical text used by both lexical indexing and query hashing. NFKC folds
 * width/compatibility variants while deliberately retaining non-ASCII letters.
 */
export function normalizeKnowledgeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Produce Unicode word tokens plus CJK character features. CJK unigrams make a
 * one-character query useful; bigrams and trigrams preserve phrase locality in
 * languages that do not require whitespace between words.
 */
export function tokenizeKnowledgeText(value: string): string[] {
  const normalized = normalizeKnowledgeText(value);
  if (!normalized) return [];

  const tokens: string[] = [];
  for (const wordMatch of normalized.matchAll(WORD_PATTERN)) {
    const word = wordMatch[0];
    if (!word) continue;
    tokens.push(word);
    for (const runMatch of word.matchAll(CJK_RUN_PATTERN)) {
      const characters = [...runMatch[0]];
      for (let size = 1; size <= 3; size += 1) {
        for (let index = 0; index + size <= characters.length; index += 1) {
          tokens.push(characters.slice(index, index + size).join(""));
        }
      }
    }
  }
  return tokens;
}

/**
 * Conservative model-independent approximation. CJK characters commonly map
 * close to one token each; remaining UTF-8 text uses the existing 4-byte/token
 * convention used by Nitely's stage context budgets.
 */
export function estimateKnowledgeTokens(value: string): number {
  if (!value) return 0;
  let cjkCharacters = 0;
  let otherText = "";
  for (const character of value) {
    if (CJK_CHARACTER_PATTERN.test(character)) {
      cjkCharacters += 1;
    } else {
      otherText += character;
    }
  }
  return cjkCharacters + Math.ceil(Buffer.byteLength(otherText, "utf8") / 4);
}

/** Return the longest Unicode-code-point-safe prefix within an approximate token cap. */
export function truncateKnowledgeText(
  value: string,
  maxTokens: number,
): TruncatedKnowledgeText {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new Error("knowledge text token limit must be a non-negative safe integer");
  }
  if (estimateKnowledgeTokens(value) <= maxTokens) {
    return { text: value, truncated: false };
  }
  if (maxTokens === 0) return { text: "", truncated: value.length > 0 };

  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (estimateKnowledgeTokens(candidate) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return {
    text: characters.slice(0, low).join(""),
    truncated: low < characters.length,
  };
}
