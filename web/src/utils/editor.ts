import type { Editor } from "@tiptap/react";
import { EditorState } from "@tiptap/pm/state";
import { cleanNoteMarkdown } from "./markdown";

/** Load a different note without carrying undo/redo history across files. */
export function loadMarkdownNote(editor: Editor | null, content: string): void {
  if (!editor || editor.isDestroyed) return;
  editor.commands.setContent(cleanNoteMarkdown(content), { contentType: "markdown", emitUpdate: false });
  const state = EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins });
  editor.view.updateState(state);
  // Notify editor-state subscribers, without adding a new history entry.
  editor.view.dispatch(state.tr.setMeta("addToHistory", false));
}
