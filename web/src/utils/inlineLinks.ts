import { safeWebUrl } from "./links";

/**
 * Links inside a plain line of text, such as a whiteboard to-do.
 *
 * The text stays an ordinary string on disk, so the board format does not
 * change. Two spellings are recognised: a bare address (`https://…`, `www.…`)
 * and the Markdown form `[label](https://…)`, which is what the whiteboard's
 * text boxes already save.
 */
export interface InlineTextSegment {
  kind: "text";
  text: string;
  start: number;
  end: number;
}

export interface InlineLinkSegment {
  kind: "link";
  /** What is shown: the label, or the address as it was typed. */
  text: string;
  /** A checked http(s) address; never anything else. */
  href: string;
  start: number;
  end: number;
  /** Where `text` begins in the raw string. */
  labelStart: number;
  markdown: boolean;
}

export type InlineSegment = InlineTextSegment | InlineLinkSegment;

// A Markdown link whose address may hold one level of balanced brackets, or a
// bare address. `\b` keeps "awww.example" and "xhttps://" from matching.
const TOKEN =
  /\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const count = (value: string, char: string) => value.split(char).length - 1;

/** Drop the sentence punctuation that follows an address rather than belonging to it. */
function trimBareUrl(raw: string): string {
  let url = raw;
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (/[.,;:!?'*_~]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && count(url, last) > count(url, opener)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

export function parseInlineLinks(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let plainFrom = 0;
  const pushText = (to: number) => {
    if (to > plainFrom) {
      segments.push({ kind: "text", text: text.slice(plainFrom, to), start: plainFrom, end: to });
    }
  };

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const start = match.index;
    if (match[1] !== undefined) {
      const href = safeWebUrl(match[2]);
      if (!href) continue;
      pushText(start);
      const end = start + match[0].length;
      segments.push({
        kind: "link",
        text: match[1],
        href,
        start,
        end,
        labelStart: start + 1,
        markdown: true,
      });
      plainFrom = end;
      continue;
    }
    const shown = trimBareUrl(match[0]);
    const href = shown ? safeWebUrl(/^www\./i.test(shown) ? `https://${shown}` : shown) : null;
    if (!href) continue;
    pushText(start);
    const end = start + shown.length;
    segments.push({ kind: "link", text: shown, href, start, end, labelStart: start, markdown: false });
    plainFrom = end;
    // Anything trimmed off the end is ordinary text again.
    TOKEN.lastIndex = end;
  }
  pushText(text.length);
  return segments;
}

/** The link that the caret or selection sits in, if it is inside exactly one. */
export function inlineLinkAt(text: string, start: number, end = start): InlineLinkSegment | null {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  for (const segment of parseInlineLinks(text)) {
    if (segment.kind === "link" && from >= segment.start && to <= segment.end) return segment;
  }
  return null;
}

/**
 * Turn what someone typed into a dialog into a checked web address.
 * `example.com` becomes `https://example.com/`; anything that is not an
 * ordinary http(s) address is refused.
 */
export function normalizeLinkInput(raw: string): string | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) return safeWebUrl(value);
  // "mailto:…" or "javascript:…", but not "localhost:3000".
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) return null;
  const safe = safeWebUrl(`https://${value}`);
  if (!safe) return null;
  const host = new URL(safe).hostname;
  return host.includes(".") || host === "localhost" ? safe : null;
}

/** How a link is written into the text: the bare address when that is enough. */
export function formatInlineLink(label: string, href: string): string {
  const clean = label.replace(/\s+/g, " ").trim().replace(/\[/g, "(").replace(/\]/g, ")");
  const parsedBare = parseInlineLinks(href);
  const bareSurvives =
    parsedBare.length === 1 && parsedBare[0].kind === "link" && parsedBare[0].href === href;
  if ((!clean || clean === href || normalizeLinkInput(clean) === href) && bareSurvives) return href;
  // Brackets in the address would end the Markdown link early.
  const address = href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${clean || address}](${address})`;
}

/** Replace `start…end` with a link, and say where the caret belongs afterwards. */
export function insertInlineLink(
  text: string,
  start: number,
  end: number,
  label: string,
  href: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, end, text.length));
  const to = Math.max(from, Math.min(Math.max(start, end), text.length));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const token = formatInlineLink(label, href);
  // A bare address runs until the next space, so it needs one on each side.
  const bare = !token.startsWith("[");
  const lead = bare && before && !/\s$/.test(before) ? " " : "";
  const trail = bare && after && !/^\s/.test(after) ? " " : "";
  const head = `${before}${lead}${token}`;
  return { text: `${head}${trail}${after}`, caret: head.length };
}

/** Take the link away but keep its words. */
export function removeInlineLink(text: string, link: InlineLinkSegment): { text: string; caret: number } {
  const head = `${text.slice(0, link.start)}${link.text}`;
  return { text: `${head}${text.slice(link.end)}`, caret: head.length };
}
