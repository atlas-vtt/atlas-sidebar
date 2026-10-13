/**
 * Name an element for screen readers with visually hidden text. Obsidian turns every `aria-label` into a
 * hover tooltip, and Atlas Sidebar shows none. Call it after drawing an icon into `el`, which empties it.
 */
export function srLabel(el: HTMLElement, text: string) {
  const span = el.querySelector<HTMLElement>(":scope > .zen-sr-only") ?? el.createSpan({ cls: "zen-sr-only" });
  if (span.textContent !== text) span.textContent = text;
}
