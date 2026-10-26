import { fileName, joinPath, parentPath, type Entry, type SearchHit } from "./vault";

// A deliberately separate, clearly labelled workspace for trying the interface.
// Real vaults always use the Tauri filesystem commands instead.
export const SAMPLE_ROOT = "comet-sample://vault";
export const SAMPLE_WELCOME = joinPath(joinPath(SAMPLE_ROOT, "00 - Start here"), "Welcome.md");
const STORAGE_KEY = "comet:sample-vault:v1";

interface SampleData {
  folders: string[];
  files: Record<string, string>;
}

type SampleStorage = Pick<Storage, "getItem" | "setItem">;

function initialData(): SampleData {
  const start = joinPath(SAMPLE_ROOT, "00 - Start here");
  const notes = joinPath(SAMPLE_ROOT, "01 - Notes");
  const projects = joinPath(SAMPLE_ROOT, "02 - Projects");
  const inbox = joinPath(SAMPLE_ROOT, "Inbox");
  return {
    folders: [start, notes, projects, inbox],
    files: {
      [SAMPLE_WELCOME]: `# A little space for big ideas.

Your thoughts deserve a place to land. Comet is a quiet corner for your notes, ideas, and everything in between.

## Make yourself at home

- **Capture the moment.** Save a thought before it floats away.
- **Find your flow.** Organize ideas in folders that make sense to you.
- **Keep it yours.** Your notes are plain Markdown files, stored locally.

> Less noise. More room to think.

---

This is your space. Make yourself at home.`,
      [joinPath(start, "Markdown guide.md")]: `# A little Markdown goes a long way

Comet keeps your notes as plain text. Use the toolbar, or type Markdown as you go.

## The basics

- Start a line with # for a heading.
- Wrap a word in **asterisks** to make it bold.
- Start a line with - to make a list.
- Use > to make a quote.

Switch to SOURCE to see the Markdown behind any note.`,
      [joinPath(notes, "Small thoughts.md")]: `# Small thoughts

A place for the things that don't need to be big to be worth keeping.

- A sentence you don't want to forget
- A question to come back to
- Something that made you smile`,
      [joinPath(notes, "Ideas.md")]: `# Ideas

A little collection of things to explore.

- Start before you're ready.
- Make space for the unexpected.
- Keep a note of what catches your attention.`,
      [joinPath(projects, "Next adventure.md")]: `# Next adventure

Every good idea starts somewhere.

## The plan

- [ ] Collect the first few thoughts
- [ ] Work out the next small step
- [ ] Get started`,
    },
  };
}

/** A tiny local-only sample, useful before a vault has been chosen. */
export function createSampleVault(storage?: SampleStorage) {
  let data = initialData();
  let persisted = false;
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as SampleData;
      if (
        Array.isArray(parsed.folders) &&
        parsed.folders.every((folder) => typeof folder === "string" && folder.startsWith(`${SAMPLE_ROOT}/`)) &&
        parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files) &&
        typeof parsed.files[SAMPLE_WELCOME] === "string" &&
        Object.entries(parsed.files).every(([path, content]) => path.startsWith(`${SAMPLE_ROOT}/`) && typeof content === "string")
      ) {
        data = parsed;
      }
    }
    persisted = Boolean(storage);
  } catch {
    // Storage may be unavailable (for example in a private browser window).
  }

  const save = () => {
    try {
      if (storage) {
        storage.setItem(STORAGE_KEY, JSON.stringify(data));
        persisted = true;
      }
    } catch {
      persisted = false;
    }
  };

  const ensureParents = (path: string) => {
    const missing: string[] = [];
    let parent = parentPath(path);
    while (parent.startsWith(`${SAMPLE_ROOT}/`) && !data.folders.includes(parent)) {
      missing.push(parent);
      parent = parentPath(parent);
    }
    data.folders.push(...missing.reverse());
  };

  return {
    isPersisted: () => persisted,
    list: (): Entry[] => [
      ...data.folders.map((path) => ({ name: fileName(path), path, kind: "folder" as const })),
      ...Object.keys(data.files).map((path) => ({ name: fileName(path), path, kind: "file" as const })),
    ],
    read: (path: string): string => {
      if (!Object.prototype.hasOwnProperty.call(data.files, path)) throw new Error("This note could not be found.");
      return data.files[path];
    },
    write: (path: string, content: string) => {
      if (!Object.prototype.hasOwnProperty.call(data.files, path)) throw new Error("This note could not be found.");
      data.files[path] = content;
      save();
    },
    createNote: (path: string, content: string) => {
      if (Object.prototype.hasOwnProperty.call(data.files, path) || data.folders.includes(path)) {
        throw new Error("An item with that name already exists.");
      }
      ensureParents(path);
      data.files[path] = content;
      save();
    },
    createFolder: (path: string) => {
      if (Object.prototype.hasOwnProperty.call(data.files, path) || data.folders.includes(path)) {
        throw new Error("An item with that name already exists.");
      }
      ensureParents(path);
      data.folders.push(path);
      save();
    },
    search: (query: string): SearchHit[] => {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      return Object.entries(data.files)
        .filter(([path, content]) => fileName(path).toLowerCase().includes(needle) || content.toLowerCase().includes(needle))
        .map(([path, content]) => ({
          path,
          name: fileName(path),
          snippet: content.split("\n").find((line) => line.toLowerCase().includes(needle))?.trim() || "Matching filename",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function browserStorage(): SampleStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const sampleVault = createSampleVault(browserStorage());
