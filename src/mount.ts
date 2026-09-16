import katex from "katex";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import {
  findMath,
  mightContainMath,
  prepareTex,
  type MathMatch,
} from "./math";
import { createMathSelectionController } from "./selection";

const PREVIEW = "[data-markdown-preview]";
const LATEX_CLASS = "bb-latex";
const OVERLAY_CLASS = "bb-latex-overlay";
const HIDDEN_SOURCE_CLASS = "bb-latex-source-hidden";
// `a` belongs here for the same reason `code` does: a rendered link is never
// maths. Without it, a match whose delimiters sit on either side of a link
// covers the anchor, and `deleteContents()` destroys it — the link is replaced
// by a formula, and the renderer that owns the anchor puts it back beside the
// formula rather than in place of it, leaving two copies of the same text.
const SKIP_CLOSEST =
  `pre, code, kbd, samp, a, script, style, textarea, .katex, .katex-display, .katex-error, .bb-latex, .${HIDDEN_SOURCE_CLASS}, [contenteditable='true']`;
const BLOCK_CLOSEST =
  "p, li, td, th, h1, h2, h3, h4, h5, h6, pre, blockquote, [data-markdown-preview]";
const CROSS_BLOCK = "p, h1, h2, h3, h4, h5, h6";
const MAX_CROSS_BLOCKS = 8;
const OBSERVE: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
};

function observeRoot(): Node {
  return document.body ?? document.documentElement;
}

export function mountLatex({ signal }: PluginContentScriptContext) {
  const selections = createMathSelectionController(document);
  const scheduled = new Set<Element>();
  let raf = 0;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const origin =
        mutation.target instanceof Element
          ? mutation.target
          : mutation.target.parentElement;
      if (origin) scheduleClosest(origin);
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) scheduleFrom(node);
      }
      for (const node of mutation.removedNodes) {
        if (node instanceof Element) scheduleFrom(node);
      }
    }
  });

  const requestFlush = () => {
    if (raf === 0) raf = requestAnimationFrame(flush);
  };

  const scheduleClosest = (node: Element) => {
    if (signal.aborted) return;
    const root = node.matches(PREVIEW) ? node : node.closest(PREVIEW);
    if (root === null) return;
    scheduled.add(root);
    requestFlush();
  };

  const scheduleFrom = (node: Element) => {
    if (signal.aborted) return;
    const roots = rootsFrom(node);
    if (roots.length === 0) return;
    for (const root of roots) scheduled.add(root);
    requestFlush();
  };

  const flush = () => {
    raf = 0;
    if (signal.aborted) return;
    const batch = [...scheduled];
    scheduled.clear();
    observer.disconnect();
    try {
      selections.reconcile();
      for (const root of batch) {
        if (!root.isConnected) continue;
        resetLatex(root);
        processRoot(root);
        selections.enhance(root);
      }
    } finally {
      if (!signal.aborted) observer.observe(observeRoot(), OBSERVE);
    }
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    scheduled.clear();
    selections.dispose();
    resetCrossBlockDisplays(document);
    for (const span of document.querySelectorAll(`.${LATEX_CLASS}`)) {
      restoreSpan(span, { force: true });
    }
  };

  observer.observe(observeRoot(), OBSERVE);
  for (const root of document.querySelectorAll(PREVIEW)) {
    scheduled.add(root);
  }
  if (scheduled.size > 0) raf = requestAnimationFrame(flush);

  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}

function rootsFrom(node: Element): Element[] {
  if (node.matches(PREVIEW)) return [node];
  const closest = node.closest(PREVIEW);
  if (closest) return [closest];
  return [...node.querySelectorAll(PREVIEW)];
}

function resetLatex(root: Element): void {
  resetCrossBlockDisplays(root);
  for (const span of root.querySelectorAll(`.${LATEX_CLASS}`)) {
    restoreSpan(span, { force: false });
  }
  root.normalize();
}

function resetCrossBlockDisplays(root: ParentNode): void {
  for (const overlay of root.querySelectorAll(`.${OVERLAY_CLASS}`)) {
    overlay.remove();
  }
  for (const source of root.querySelectorAll(`.${HIDDEN_SOURCE_CLASS}`)) {
    source.classList.remove(HIDDEN_SOURCE_CLASS);
  }
}

function restoreSpan(span: Element, { force }: { force: boolean }): void {
  const source = span.getAttribute("data-bb-latex-source") ?? "";
  if (!force && sourceAlreadyPresent(span, source)) {
    span.remove();
    return;
  }
  span.replaceWith(document.createTextNode(source));
}

function sourceAlreadyPresent(span: Element, source: string): boolean {
  if (source.length === 0) return false;
  const prev = span.previousSibling;
  const next = span.nextSibling;
  return (
    (prev?.nodeType === Node.TEXT_NODE &&
      (prev.textContent ?? "").includes(source)) ||
    (next?.nodeType === Node.TEXT_NODE &&
      (next.textContent ?? "").includes(source))
  );
}

function processRoot(root: Element): void {
  processCrossBlockDisplays(root);
  for (const run of collectBlockRuns(root)) {
    processRun(run);
  }
}

function processCrossBlockDisplays(root: Element): void {
  const candidates = [...root.querySelectorAll(CROSS_BLOCK)];
  for (const first of candidates) {
    if (!first.isConnected || first.classList.contains(HIDDEN_SOURCE_CLASS)) {
      continue;
    }
    if (
      first.closest(PREVIEW) !== root ||
      first.closest("pre") !== null ||
      containsProtectedContent(first)
    ) {
      continue;
    }

    const firstText = elementTextWithBreaks(first);
    if (!/^\s*\[/.test(firstText) || fullBracketDisplay(firstText) !== null) {
      continue;
    }

    const blocks = [first];
    const fragments = [firstText];
    let combined = firstText;
    let current = first;
    for (let count = 1; count < MAX_CROSS_BLOCKS; count += 1) {
      const next = current.nextElementSibling;
      if (
        next === null ||
        !next.matches(CROSS_BLOCK) ||
        next.closest(PREVIEW) !== root ||
        containsProtectedContent(next)
      ) {
        break;
      }

      const nextText = elementTextWithBreaks(next);
      blocks.push(next);
      fragments.push(nextText);
      combined += crossBlockSeparator(current);
      combined += nextText;
      const display = fullBracketDisplay(combined);
      if (display !== null) {
        if (isPlausibleCrossBlockMath(fragments, display.match.body)) {
          const overlay = renderMatch(
            `${display.match.body}${display.suffix}`,
            combined.trim(),
            true,
          );
          if (
            !overlay.matches(".bb-latex-error") &&
            !overlay.querySelector(".katex-error")
          ) {
            overlay.classList.add(OVERLAY_CLASS);
            first.before(overlay);
            for (const block of blocks) block.classList.add(HIDDEN_SOURCE_CLASS);
          }
        }
        break;
      }
      current = next;
    }
  }
}

function crossBlockSeparator(previous: Element): string {
  if (previous.matches("h1")) return "\n=\n";
  if (previous.matches("h2")) return "\n-\n";
  return "\n\n";
}

type FullBracketDisplay = {
  match: MathMatch;
  suffix: string;
};

function fullBracketDisplay(text: string): FullBracketDisplay | null {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== "[") return null;
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;

  for (const match of findMath(text)) {
    if (!match.display || match.start !== start) continue;
    if (!match.raw.startsWith("[") || !match.raw.endsWith("]")) continue;
    if (match.body !== match.raw.slice(1, -1).trim()) continue;
    const suffix = text.slice(match.end, end);
    if (/^[ \t\u00a0.,;:!?。，、]*$/.test(suffix)) {
      return { match, suffix };
    }
  }
  return null;
}

function isPlausibleCrossBlockMath(
  fragments: string[],
  body: string,
): boolean {
  if (body.includes("$")) return false;
  for (let i = 0; i < fragments.length; i += 1) {
    const source = fragments[i] ?? "";
    const fragment = (i === 0 ? source.replace(/^\s*\[/, "") : source).trim();
    if (fragment.length === 0 || /^[=+\-]$/.test(fragment)) continue;
    if (/\\[A-Za-z]+/.test(fragment)) return true;
    if (/[A-Za-z]{3,}/.test(fragment)) return false;
    return (
      /[_^{}=+\-*/<>≤≥≠≈]/.test(fragment) ||
      /^[0-9]*[A-Za-z][A-Za-z0-9]?$/.test(fragment) ||
      /^[A-Za-z][A-Za-z0-9]*\([^)]{1,40}\)$/.test(fragment)
    );
  }
  return false;
}

function containsProtectedContent(element: Element): boolean {
  return element.querySelector(SKIP_CLOSEST) !== null;
}

function elementTextWithBreaks(element: Element): string {
  let text = "";

  const visit = (node: Node): void => {
    if (node instanceof Text) {
      text += node.nodeValue ?? "";
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(SKIP_CLOSEST)) return;
    if (node.matches("br")) {
      text += "\n";
      return;
    }
    const marker = markdownStarMarker(node, text);
    text += marker;
    for (const child of node.childNodes) visit(child);
    text += marker;
  };

  for (const child of element.childNodes) visit(child);
  return text;
}

function markdownStarMarker(element: Element, prefix: string): string {
  let marker = "";
  if (element.matches("strong")) marker = "**";
  else if (element.matches("em")) marker = "*";
  if (marker.length === 0 || !prefix.endsWith("^")) return "";
  return (element.textContent ?? "").endsWith("^") ? marker : "";
}

type BlockRun = {
  nodes: Text[];
  starts: number[];
  text: string;
};

function collectBlockRuns(root: Element): BlockRun[] {
  const candidates = [
    ...(root.matches(BLOCK_CLOSEST) ? [root] : []),
    ...root.querySelectorAll(BLOCK_CLOSEST),
  ];
  const runs: BlockRun[] = [];
  for (const block of candidates) {
    if (block.closest("pre") !== null || block.matches(SKIP_CLOSEST)) continue;
    runs.push(...projectBlock(block));
  }
  return runs;
}

function projectBlock(block: Element): BlockRun[] {
  const runs: BlockRun[] = [];
  let nodes: Text[] = [];
  let starts: number[] = [];
  let text = "";

  const flush = () => {
    if (nodes.length > 0) runs.push({ nodes, starts, text });
    nodes = [];
    starts = [];
    text = "";
  };

  const visit = (node: Node): void => {
    if (node instanceof Text) {
      if (
        (node.nodeValue ?? "").length === 0 ||
        shouldSkip(node) ||
        node.parentElement?.closest(BLOCK_CLOSEST) !== block
      ) {
        flush();
        return;
      }
      starts.push(text.length);
      nodes.push(node);
      text += node.nodeValue ?? "";
      return;
    }
    if (!(node instanceof Element)) return;
    if (
      node.matches(SKIP_CLOSEST) ||
      (node.matches(BLOCK_CLOSEST) && node !== block)
    ) {
      flush();
      return;
    }
    if (node.matches("br")) {
      text += "\n";
      return;
    }
    const marker = markdownStarMarker(node, text);
    text += marker;
    for (const child of node.childNodes) visit(child);
    text += marker;
  };

  for (const child of block.childNodes) visit(child);
  flush();
  return runs;
}

function shouldSkip(node: Text): boolean {
  const parent = node.parentElement;
  if (parent === null) return true;
  return parent.closest(SKIP_CLOSEST) !== null;
}

function processRun({ nodes, starts, text }: BlockRun): void {
  if (nodes.length === 0 || !mightContainMath(text)) return;

  const matches = findMath(text);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (match === undefined) continue;
    applyMatch(nodes, starts, match);
  }
}

function applyMatch(nodes: Text[], starts: number[], match: MathMatch): void {
  const start = locateStart(nodes, starts, match.start);
  const end = locateEnd(nodes, starts, match.end);
  if (start === null || end === null) return;
  if (!start.node.isConnected || !end.node.isConnected) return;

  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return;
  }
  if (range.collapsed) return;

  const span = renderMatch(match.body, match.raw, match.display);
  if (
    span.matches(".bb-latex-error") ||
    span.querySelector(".katex-error")
  ) {
    return;
  }
  range.deleteContents();
  range.insertNode(span);
}

function locateStart(
  nodes: Text[],
  starts: number[],
  index: number,
): { node: Text; offset: number } | null {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const start = starts[i];
    if (node === undefined || start === undefined) continue;
    const length = node.nodeValue?.length ?? 0;
    if (index >= start && index < start + length) {
      return { node, offset: index - start };
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    if (starts[i] === index && nodes[i] !== undefined) {
      return { node: nodes[i], offset: 0 };
    }
  }
  return null;
}

function locateEnd(
  nodes: Text[],
  starts: number[],
  index: number,
): { node: Text; offset: number } | null {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const start = starts[i];
    if (node === undefined || start === undefined) continue;
    const length = node.nodeValue?.length ?? 0;
    if (index > start && index <= start + length) {
      return { node, offset: index - start };
    }
  }
  if (index === 0 && nodes[0] !== undefined) {
    return { node: nodes[0], offset: 0 };
  }
  return null;
}

function renderMatch(body: string, raw: string, display: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = display
    ? `${LATEX_CLASS} bb-latex-display`
    : `${LATEX_CLASS} bb-latex-inline`;
  span.setAttribute("data-bb-latex-source", raw);
  try {
    katex.render(prepareTex(body), span, {
      displayMode: display,
      throwOnError: true,
      output: "htmlAndMathml",
      trust: false,
      strict: "ignore",
    });
  } catch {
    span.classList.add("bb-latex-error");
    span.textContent = raw;
  }
  return span;
}
