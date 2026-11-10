import wordList from "../data/eff-long-words.txt?raw";

// Adapted EFF Long Wordlist, bundled for offline use. Attribution and license:
// src/licenses/eff-wordlist.txt. Words are sampled independently with replacement.
export const PASSPHRASE_WORDS = wordList.trim().split(/\r?\n/);
export const APPLE_STYLE_ENTROPY = Math.log2(18 * 17) + 17 * Math.log2(26) + Math.log2(10);

/** Draw without modulo bias. A cryptographic source is mandatory; never fall back to Math.random. */
export function randomIndex(limit: number, source: Pick<Crypto, "getRandomValues"> | undefined = globalThis.crypto): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 0x100000000) throw new Error("Invalid random range.");
  if (!source || typeof source.getRandomValues !== "function") throw new Error("Secure randomness is unavailable on this device.");
  const cutoff = Math.floor(0x100000000 / limit) * limit;
  const value = new Uint32Array(1);
  do { source.getRandomValues(value); } while (value[0] >= cutoff);
  return value[0] % limit;
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+";
const pick = (characters: string, source?: Pick<Crypto, "getRandomValues">) => characters[randomIndex(characters.length, source)];

/** Three groups of six, with exactly one uppercase letter and one digit.
 * This is Apple-inspired formatting, not Apple's proprietary algorithm. */
export function makeAppleStylePassword(source?: Pick<Crypto, "getRandomValues">): string {
  const capitalIndex = randomIndex(18, source);
  let digitIndex = randomIndex(17, source);
  if (digitIndex >= capitalIndex) digitIndex++;
  const characters = Array.from({ length: 18 }, (_, index) =>
    index === capitalIndex ? pick(UPPER, source) : index === digitIndex ? pick(DIGITS, source) : pick(LOWER, source));
  return [characters.slice(0, 6), characters.slice(6, 12), characters.slice(12, 18)].map((group) => group.join("")).join("-");
}

export interface CharacterOptions { lowercase: boolean; uppercase: boolean; numbers: boolean; symbols: boolean }
/** Uniformly sample strings from the chosen alphabet, conditioned on each
 * selected character group appearing at least once. */
export function makeCharacterPassword(length: number, options: CharacterOptions, source?: Pick<Crypto, "getRandomValues">): string {
  const groups = [options.lowercase && LOWER, options.uppercase && UPPER, options.numbers && DIGITS, options.symbols && SYMBOLS].filter((group): group is string => !!group);
  if (!Number.isInteger(length) || length < 12 || length > 64) throw new Error("Choose a length between 12 and 64.");
  if (!groups.length) throw new Error("Choose at least one character type.");
  const alphabet = groups.join("");
  // Rejection rather than appending/shuffling required characters keeps every
  // valid output equally likely. At 12+ characters rejection is inexpensive.
  for (let attempts = 0; attempts < 10000; attempts++) {
    const result = Array.from({ length }, () => pick(alphabet, source)).join("");
    if (groups.every((group) => [...result].some((character) => group.includes(character)))) return result;
  }
  throw new Error("Couldn't generate a password. Please try again.");
}

export function makeWordPassphrase(count: number, separator: string, capitalize: boolean, addDigit: boolean, source?: Pick<Crypto, "getRandomValues">): string {
  if (!Number.isInteger(count) || count < 4 || count > 12) throw new Error("Choose between 4 and 12 words.");
  if (!["-", " ", ".", "_"].includes(separator)) throw new Error("Choose a supported separator.");
  const words = Array.from({ length: count }, () => {
    const word = PASSPHRASE_WORDS[randomIndex(PASSPHRASE_WORDS.length, source)];
    return capitalize ? word[0].toUpperCase() + word.slice(1) : word;
  });
  return words.join(separator) + (addDigit ? pick(DIGITS, source) : "");
}
export const passphraseEntropy = (count: number, addDigit: boolean) => count * Math.log2(PASSPHRASE_WORDS.length) + (addDigit ? Math.log2(10) : 0);
