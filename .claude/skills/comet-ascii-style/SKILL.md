---
name: "Comet ASCII Style"
description: "ASCII style guide for the Comet note app UI. Enforces monospace fonts, box drawing characters, luxury minimalism, a black based palette with the Matterhorn background, keyboard first navigation, and no em dashes. Use when styling Comet components, writing UI copy, or reviewing CSS and layout."
---

# Comet ASCII Style

## What This Skill Does

This skill enforces the visual and written style of Comet, a local first note taking app.
Every UI element, every line of copy, every CSS rule should follow these rules so the app
keeps its luxury, minimal, ASCII aesthetic and stays snappy.

## When to Use This Skill

- When writing or reviewing CSS, layout or component markup for Comet.
- When adding new UI elements, buttons, panes, menus or dialogs.
- When writing UI copy, labels, status text or error messages.
- When checking that a change does not break the ASCII aesthetic.

---

## Core Rules

### 1. Monospace Only

Every piece of UI text must be monospace. No proportional fonts, no variable weight UI
fonts, no system UI fonts. The approved stack is:

    "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace

Apply it at the root so everything inherits it. Do not override it per component.

### 2. Box Drawing

Use box drawing characters for borders and structure where they improve clarity:

    ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼   or   + - |   as a fallback for terminals without Unicode.

Prefer the Unicode set. Fall back to `+ - |` only when rendering outside a controlled
environment (for example, plain text exports).

### 3. Luxury Minimalism

- No rounded corners. Square corners only.
- No drop shadows, gradients, blur, glassmorphism or glow.
- No animations except instant state changes (opacity, display). Nothing that moves.
- No decorative chrome. Every pixel must earn its place.
- Generous whitespace over decoration.

### 4. Color Palette (Black Based)

Base around black. The default theme uses these tokens:

    --bg:       #0b0a16   (background)
    --fg:       #e6e6e6   (text)
    --dim:      #8b8577   (secondary text, status)
    --accent:   #b9a07e   (headings, focus, active)
    --border:   #26232e   (borders, separators)
    --error:    #c95a5a   (errors only)

Themes may be added later, but every theme must keep the same structural rules and
stay within a small palette (2 to 4 colors plus background).

### 5. Matterhorn Background

The Matterhorn mountain is used as a background image.

- Desaturated, very low opacity, never interfering with readability.
- No parallax, no animation, no movement.
- It sits behind the content and must never reduce contrast of text or controls.
- If it cannot be read over, drop the opacity further or remove it.

### 6. Text Over Icons

- Prefer text labels over iconography. `[ open vault ]` over an icon.
- If an icon is used, it must be monospace friendly or pure text.
- Buttons, menu items and status indicators are text first.

### 7. Keyboard First

- Every action must be reachable by keyboard.
- Tree traversal, toggles, the command palette and the preview toggle all have
  keyboard shortcuts.
- Focus must be visible: a 1px accent border or a clear text highlight, never a glow.

### 8. Tree Visualizer

The file explorer is a tree. Folders can be created at any level and files can be
placed anywhere inside them.

- Use ASCII indentation for nesting: `├──` and `└──`.
- Folders and files are visually distinct through a glyph or label, not color alone.
- The tree is keyboard navigable.

### 9. Toggleable Preview

Markdown preview is toggleable, not forced side by side. When off, the editor takes
the full width. When on, the preview pane sits beside the editor.

### 10. Brevity

Keep all UI copy as short as possible. `[ open vault ]`, not `Open your vault folder`.
Status text is one line. Errors are one sentence.

### 11. No Em Dashes

Never use em dashes in any UI copy, documentation, comments or notes.
Use a hyphen, a comma, or restructure the sentence.

- Wrong: "Comet is fast — and simple."
- Right: "Comet is fast - and simple." or "Comet is fast, and simple."

---

## Layout

- Three panes when preview is open: explorer, editor, preview.
- Two panes when preview is closed: explorer, editor.
- No rounded corners, no shadows, no blur on any pane.
- Borders are 1px solid using the border color.
- The window uses the OS title bar; the in app chrome is minimal.

## Components

- Buttons: text labels in brackets, `[ action ]`, accent color on hover/focus.
- Inputs and textareas: transparent background, no border radius, monospace.
- Lists: plain text with ASCII bullets or numbers.
- Code blocks: monospace, 1px border, dim background.

## Snappiness

- No animations. Instant state changes only.
- Virtualize long lists where needed.
- Keep CSS minimal and avoid expensive selectors.
- Prefer Rust for file operations, JS for rendering.

---

## Checklist Before Shipping a Change

- [ ] Monospace font inherited everywhere, no exceptions.
- [ ] No rounded corners, shadows, gradients or blur.
- [ ] Palette uses only the approved tokens.
- [ ] Matterhorn background, if used, is dim and static.
- [ ] All buttons and labels are text first.
- [ ] Keyboard navigation still works.
- [ ] No em dashes anywhere in the change.
- [ ] UI copy is as short as possible.
