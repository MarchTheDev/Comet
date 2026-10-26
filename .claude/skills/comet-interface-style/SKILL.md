---
name: "Comet Interface Style"
description: "Design and accessibility guidance for the Comet local-first note app. Use when working on its interface, interactions, or UI copy."
---

# Comet Interface Style

Comet should feel calm, modern, and easy to understand. Put the user's notes and
folders first, with a light, spacious interface and a prominent but unobtrusive
photograph of the Matterhorn.

## Design principles

- Use the bundled Manrope typeface for interface and note text. Keep source code
  and Markdown source comfortably monospaced.
- Use the existing soft blue, slate, and white palette, subtle borders, rounded
  surfaces, and generous whitespace. Keep the mountain photograph static and
  preserve readable contrast over it.
- Prefer clear labels and familiar Lucide icons. Icon-only controls need an
  accessible name, a tooltip, and a visible keyboard focus state.
- Make primary actions obvious. Keep everyday actions such as new note, search,
  quick capture, rename, and delete easy to find without relying on right-click.
- Adapt gracefully to small screens and support keyboard use. Respect reduced
  motion preferences.
- Write brief, friendly copy. Explain destructive actions and failed saves in
  plain language, including what the user can do next.

## Local-first behavior

- Real workspaces are folders of Markdown files on the user's computer. Never
  imply that the browser sample is a real local vault.
- Preserve autosave and wait for pending writes before navigating away or changing
  files. Never silently overwrite existing files.
- Clearly confirm permanent deletion, including folder contents. Do not imply
  that an item goes to the trash if it does not.
- Keep relative Markdown links portable and prevent filesystem operations from
  escaping the workspace.

## Before shipping

- Check desktop and mobile layouts, keyboard focus, and screen-reader labels.
- Verify the editor, search, create, rename, delete, quick capture, and failed-save
  flows in both the sample and desktop bridge when relevant.
- Keep the Matterhorn visible without compromising the editor's readability.
