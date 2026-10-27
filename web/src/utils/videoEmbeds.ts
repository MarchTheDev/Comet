import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoPlayer } from "../MediaPlayer";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { videoLink, type VideoLink } from "./links";

const roots = new WeakMap<Node, Root>();
function player(video: VideoLink): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "inline-video";
  wrap.contentEditable = "false";
  if (video.kind === "youtube") {
    const frame = document.createElement("iframe");
    frame.title = `YouTube video ${video.id}`;
    frame.src = `https://www.youtube-nocookie.com/embed/${video.id}`;
    frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    wrap.appendChild(frame);
  } else {
    const root = createRoot(wrap); roots.set(wrap, root);
    root.render(createElement(VideoPlayer, { url: video.url, name: "Linked video" }));
  }
  return wrap;
}

function decorations(doc: ProseMirrorNode): DecorationSet {
  const widgets: Decoration[] = [];
  const counts = new Map<string, number>();
  const add = (pos: number, url: string) => {
    if (widgets.length >= 50) return; // Avoid unbounded network requests in a hostile document.
    const link = videoLink(url); if (!link) return;
    const identity = link.kind === "youtube" ? `youtube:${link.id}` : `video:${link.url}`;
    const occurrence = counts.get(identity) ?? 0; counts.set(identity, occurrence + 1);
    widgets.push(Decoration.widget(pos, () => player(link), { key: `${identity}:${occurrence}`, side: 1, ignoreSelection: true, destroy: (node) => { const root = roots.get(node); if (root) { roots.delete(node); queueMicrotask(() => root.unmount()); } } }));
  };
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    let pendingUrl = ""; let pendingEnd = 0;
    const flush = () => { if (pendingUrl) add(pendingEnd, pendingUrl); pendingUrl = ""; };
    node.forEach((child, offset) => {
      const href = child.marks.find((mark) => mark.type.name === "link")?.attrs.href;
      if (typeof href === "string") {
        if (pendingUrl && pendingUrl !== href) flush();
        pendingUrl = href; pendingEnd = pos + 1 + offset + child.nodeSize;
      } else {
        flush();
        if (!child.isText || !child.text) return;
        const matcher = /https?:\/\/[^\s<>()\]]+/gi;
        for (const match of child.text.matchAll(matcher)) {
          const url = match[0].replace(/[.,!?]+$/, "");
          add(pos + 1 + offset + (match.index ?? 0) + url.length, url);
        }
      }
    });
    flush();
    return false;
  });
  return DecorationSet.create(doc, widgets);
}

const videoKey = new PluginKey<DecorationSet>("cometVideoEmbeds");

/** Widgets are editor decorations, not document nodes: the Markdown remains
 * untouched, and stable keys preserve the iframe while unrelated text changes. */
export const VideoEmbeds = Extension.create({
  name: "cometVideoEmbeds",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: videoKey,
      state: { init: (_, state) => decorations(state.doc), apply: (transaction, old) => transaction.docChanged ? decorations(transaction.doc) : old.map(transaction.mapping, transaction.doc) },
      props: { decorations: (state) => videoKey.getState(state) ?? null },
    })];
  },
});
