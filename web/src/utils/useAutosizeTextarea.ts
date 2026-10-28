import { useLayoutEffect, type RefObject } from "react";

/** Let the surrounding workspace scroll while a source editor grows or shrinks. */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, active: boolean, fontSize: number) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const resize = () => {
      const scroller = element.closest<HTMLElement>(".workspace-scroll");
      const top = scroller?.scrollTop ?? 0;
      const wasAtBottom = !!scroller && top > 0 && top >= scroller.scrollHeight - scroller.clientHeight - 2;
      // Reset before measuring so deleting text can shrink the editor as well.
      // Reading scrollHeight forces layout, so preserve the workspace scroll
      // position while the textarea is temporarily short.
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
      if (scroller) scroller.scrollTop = wasAtBottom ? scroller.scrollHeight - scroller.clientHeight : top;
    };
    resize();
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize(); }
    });
    observer?.observe(element);
    document.fonts?.addEventListener?.("loadingdone", resize);
    return () => { observer?.disconnect(); document.fonts?.removeEventListener?.("loadingdone", resize); };
  }, [ref, value, active, fontSize]);
}
