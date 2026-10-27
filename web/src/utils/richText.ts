import { TextStyle, Color, FontSize } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";

/** Markdown has no standard text color or font-size syntax. Keep those styles
 * in safe inline HTML spans so reopening a Markdown file doesn't lose them. */
export const StyledText = TextStyle.extend({
  // Keep Markdown marks outside the HTML span: Markdown syntax inside an HTML
  // element is treated as literal text by the parser on reopening.
  priority: 90,
  renderMarkdown(node, helpers) {
    const color = typeof node.attrs?.color === "string" && /^(?:#[0-9a-f]{3,8}|[a-z]+|rgba?\([0-9.,%\s]+\))$/i.test(node.attrs.color) ? node.attrs.color : "";
    const size = typeof node.attrs?.fontSize === "string" && /^(?:\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(?:px|pt|em|rem|%)$/i.test(node.attrs.fontSize) ? node.attrs.fontSize : "";
    const style = [color && `color: ${color}`, size && `font-size: ${size}`].filter(Boolean).join("; ");
    const content = helpers.renderChildren(node);
    return style ? `<span style="${style}">${content}</span>` : content;
  },
});

// Tiptap's ==highlight== syntax inside a Markdown link is parsed literally.
// Inline HTML is understood both inside and outside link labels. Keep other
// Markdown marks outside this tag, and the styled span inside it.
export const SafeHighlight = Highlight.extend({
  priority: 95,
  renderMarkdown(node, helpers) { return `<mark>${helpers.renderChildren(node)}</mark>`; },
});

export const richTextExtensions = [StyledText, Color, FontSize, SafeHighlight];
