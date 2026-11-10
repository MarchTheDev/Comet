/**
 * Comet note parsing: a small, safe Markdown subset rendered as plain data
 * structures rather than into HTML, so the editor and the preview can never
 * disagree about what a note says.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "br" }
  | { kind: "strong"; text: string }
  | { kind: "strongEm"; text: string }
  | { kind: "em"; text: string }
  | { kind: "underline"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "spoiler"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export interface ListItem {
  inlines: Inline[];
  /** A `- [ ]` line, which is drawn as a checkbox rather than a dot. */
  box?: boolean;
  done?: boolean;
  /** The number a `3.` line was written with, kept so it stays that number. */
  number?: number;
}

export type Block =
  | { kind: "blank" }
  | { kind: "p"; inlines: Inline[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "code"; text: string; language: string }
  | { kind: "rule" };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^(\d+)[.)]\s+(.*)$/;
const CHECK = /^\[([ xX])\]\s+(.*)$/;
const RULE = /^(---+|\*\*\*+|___+)$/;
const QUOTE = /^(>{1,3})\s?(.*)$/;

/** Markdown markers that are common in Discord messages, ordered longest first. */
const TOKEN =
  /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\|\|[^|]+\|\||\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>]+)/gi;

/** The lines of a note, grouped into the blocks they make. */
export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let fenced: { language: string; lines: string[] } | null = null;
  let quoteAll = false;

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push({ kind: "p", inlines: parseLines(paragraph) });
    paragraph = [];
  };

  const appendQuoteLine = (line: string) => {
    const last = out[out.length - 1];
    if (last?.kind === "quote") last.inlines.push({ kind: "br" }, ...parseInline(line));
    else out.push({ kind: "quote", inlines: parseInline(line) });
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (fenced) {
      if (/^```\s*$/.test(trimmed)) {
        out.push({ kind: "code", text: fenced.lines.join("\n"), language: fenced.language });
        fenced = null;
      } else {
        fenced.lines.push(raw);
      }
      continue;
    }

    if (/^```/.test(trimmed)) {
      flush();
      fenced = { language: trimmed.slice(3).trim().split(/\s+/)[0] ?? "", lines: [] };
      quoteAll = false;
      continue;
    }

    if (trimmed === "") {
      flush();
      quoteAll = false;
      out.push({ kind: "blank" });
      continue;
    }

    // `>>>` quotes every following line up to the next blank.
    if (quoteAll && !QUOTE.test(trimmed)) {
      flush();
      appendQuoteLine(raw.trimEnd());
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flush();
      quoteAll = false;
      out.push({ kind: "h", level: heading[1].length as 1 | 2 | 3 | 4, inlines: parseInline(heading[2]) });
      continue;
    }

    if (RULE.test(trimmed)) {
      flush();
      quoteAll = false;
      out.push({ kind: "rule" });
      continue;
    }

    const quote = QUOTE.exec(trimmed);
    if (quote) {
      flush();
      appendQuoteLine(quote[2]);
      quoteAll = quoteAll || quote[1].length === 3;
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    if (bullet) {
      flush();
      quoteAll = false;
      const box = CHECK.exec(bullet[1]);
      const item: ListItem = box
        ? { box: true, done: box[1].toLowerCase() === "x", inlines: parseInline(box[2]) }
        : { inlines: parseInline(bullet[1]) };
      const last = out[out.length - 1];
      if (last?.kind === "ul") last.items.push(item);
      else out.push({ kind: "ul", items: [item] });
      continue;
    }

    const numbered = NUMBERED.exec(trimmed);
    if (numbered) {
      flush();
      quoteAll = false;
      const item: ListItem = { inlines: parseInline(numbered[2]), number: Number.parseInt(numbered[1], 10) };
      const last = out[out.length - 1];
      if (last?.kind === "ol") last.items.push(item);
      else out.push({ kind: "ol", items: [item] });
      continue;
    }

    quoteAll = false;
    paragraph.push(raw.trimEnd());
  }

  flush();
  if (fenced) out.push({ kind: "code", text: fenced.lines.join("\n"), language: fenced.language });
  return out;
}

/** Toggle the Nth `- [ ]` / `- [x]` task item outside fenced code blocks. */
export function toggleMarkdownTask(markdown: string, taskIndex: number): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let seen = 0;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (inFence) {
      if (/^```\s*$/.test(trimmed)) inFence = false;
      return line;
    }
    if (/^```/.test(trimmed)) {
      inFence = true;
      return line;
    }
    const match = /^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/.exec(line);
    if (!match) return line;
    if (seen++ !== taskIndex) return line;
    return `${match[1]}${match[2].toLowerCase() === "x" ? " " : "x"}${match[3]}`;
  }).join("\n");
}

/** One line's worth of Discord-style inline formatting. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const piece of text.split(TOKEN).filter((part) => part !== "")) {
    const both = /^\*\*\*(.+)\*\*\*$/.exec(piece);
    if (both) {
      out.push({ kind: "strongEm", text: both[1] });
      continue;
    }
    const bold = /^\*\*(.+)\*\*$/.exec(piece);
    if (bold) {
      out.push({ kind: "strong", text: bold[1] });
      continue;
    }
    const underline = /^__([\s\S]+?)__$/.exec(piece);
    if (underline) {
      out.push({ kind: "underline", text: underline[1] });
      continue;
    }
    const strike = /^~~(.+)~~$/.exec(piece);
    if (strike) {
      out.push({ kind: "strike", text: strike[1] });
      continue;
    }
    const spoiler = /^\|\|(.+)\|\|$/.exec(piece);
    if (spoiler) {
      out.push({ kind: "spoiler", text: spoiler[1] });
      continue;
    }
    const italic = /^(\*|_)(.+)\1$/.exec(piece);
    if (italic) {
      out.push({ kind: "em", text: italic[2] });
      continue;
    }
    const code = /^`(.+)`$/.exec(piece);
    if (code) {
      out.push({ kind: "code", text: code[1] });
      continue;
    }
    const link = /^\[([^\]]+)\]\(((?:https?:\/\/|steam:\/\/)[^)\s]+)\)$/i.exec(piece);
    if (link) {
      out.push({ kind: "link", text: link[1], href: link[2] });
      continue;
    }
    const autolink = /^<(https?:\/\/[^>\s]+)>$/i.exec(piece);
    if (autolink) {
      out.push({ kind: "link", text: autolink[1], href: autolink[1] });
      continue;
    }
    const url = /^(https?:\/\/[^\s<>]+)$/i.exec(piece);
    if (url) {
      const href = url[1].replace(/[.,!?;:]+$/, "");
      const trailing = url[1].slice(href.length);
      if (href) out.push({ kind: "link", text: href, href });
      if (trailing) out.push({ kind: "text", text: trailing });
      continue;
    }
    out.push({ kind: "text", text: piece });
  }
  return out;
}

const NBSP_BLANK_LINE = /^[ \t]*(?:&(?:amp;)*nbsp;|&#160;|&#xa0;|\u00a0)[ \t]*$/i;

/**
 * Strip blank-line `&nbsp;` / `&amp;nbsp;` artifacts outside fenced code blocks
 * so Markdown source stays clean and never accumulates entity noise.
 */
export function cleanNoteMarkdown(markdown: string): string {
  if (!markdown || !/(?:nbsp|&#160;|&#xa0;|\u00a0)/i.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  let fence: "`" | "~" | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceHit = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceHit) {
      const ch = fenceHit[1][0] as "`" | "~";
      const len = fenceHit[1].length;
      if (!fence) {
        fence = ch;
        fenceLen = len;
      } else if (ch === fence && len >= fenceLen && /^\s*(?:`{3,}|~{3,})\s*$/.test(line)) {
        fence = null;
        fenceLen = 0;
      }
      continue;
    }
    if (!fence && NBSP_BLANK_LINE.test(line)) {
      lines[i] = "";
    }
  }
  return lines.join("\n");
}

/** Count note words without counting Markdown syntax, HTML entities, or link destinations. */
export function countWords(markdown: string): number {
  const text = cleanNoteMarkdown(markdown)
    .replace(/&(?:amp;)*(?:nbsp|#160|#xa0);/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/<\/?(?:span|mark|u|br)\b[^>]*>/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+\[[ xX]\](?=\s|$)/gm, " ")
    .replace(/^\s*\d+[.)]\s+/gm, " ")
    .replace(/^\s*(?:`{3,}|~{3,})[^\n]*/gm, " ");
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** The plain text of a run of inlines, used for headings and list labels. */
export function inlineText(inlines: Inline[]): string {
  return inlines
    .map((x) => (x.kind === "br" ? "" : x.text))
    .join("");
}

/** Lines of one paragraph, with the line breaks the player typed kept. */
function parseLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ kind: "br" });
    out.push(...parseInline(line));
  });
  return out;
}
