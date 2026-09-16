export type MathMatch = {
  start: number;
  end: number;
  body: string;
  raw: string;
  display: boolean;
};

const MAX_BODY = 2000;

const MATH_SIGNAL =
  /[_^=+*/<>|≤≥≠≈∈∉⊂⊃∞∫∑∏√∂∇·×÷±∓→←⇒⇔∀∃λθαβγπσωμΔΩℝℂℕℤℚ{}\\^]/;

/**
 * A file path, e.g. `internal/infrastructure/groups/in_memory/repo.go:39`.
 * Worth recognising explicitly because it trips two heuristics below at once:
 * the separating slashes read as division and an `_` in a name like `in_memory`
 * reads as a subscript, which together are enough for `isPlausibleParenMath` to
 * accept a bracketed path as a formula. A path needs a slash and a file
 * extension, so it is cheap to spot and never something a reader wanted typeset.
 */
const FILE_PATH = /\w\/[\w./-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+)?/;

const SIMPLE_IDENT = /^[A-Za-z][A-Za-z0-9]*$/;
const ALL_CAPS_IDENT = /^[A-Z][A-Z0-9_]{2,}$/;
const CURRENCY_OR_NUMBER =
  /^[\d,.]+(?:\s*(?:k|K|m|M|usd|USD|usdt|USDT))?$/;
const GREEK = /^[\u0370-\u03FF\u1F00-\u1FFF]+$/;
const FN_CALL = /^[A-Za-z][A-Za-z0-9]*\([^)]{0,40}\)$/;
const SHORT_SUBSCRIPT = /^[A-Za-z][A-Za-z0-9]*(_\{[^}]+\}|_[A-Za-z0-9])+$/;
const SIMPLE_NUMERIC_EQUATION =
  /^[A-Za-z\u0370-\u03FF\u1F00-\u1FFF]\s*=\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\.?$/;
const SIMPLE_RECIPROCAL =
  /^1\s*\/\s*[A-Za-z\u0370-\u03FF\u1F00-\u1FFF](?:[0-9]+|_[A-Za-z0-9]+)?$/;

export function mightContainMath(text: string): boolean {
  return (
    text.includes("$") ||
    text.includes("\\(") ||
    text.includes("\\[") ||
    text.includes("[") ||
    text.includes("(") ||
    /\\[A-Za-z]+/.test(text)
  );
}

export function isPlausibleInlineMath(body: string): boolean {
  if (body.length === 0 || body.length > MAX_BODY) return false;
  if (body !== body.trim()) return false;
  if (/[\r\n]/.test(body)) return false;
  const hasTexCommand = /\\[A-Za-z]+/.test(body);
  if (!hasTexCommand && (/^\d/.test(body) || CURRENCY_OR_NUMBER.test(body))) {
    return false;
  }
  // A TeX command still wins: `\frac{a}{b.c}` is maths that happens to look
  // path-shaped. Without one, a path is a path.
  if (!hasTexCommand && FILE_PATH.test(body)) return false;
  if (ALL_CAPS_IDENT.test(body)) return false;
  if (hasTexCommand || MATH_SIGNAL.test(body)) return true;
  if (GREEK.test(body) || FN_CALL.test(body)) return true;
  if (isCommaSeparatedMathAtoms(body)) return true;
  return SIMPLE_IDENT.test(body) && body.length <= 8;
}

export function isPlausibleDisplayMath(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY) return false;
  if (/\\[A-Za-z]+/.test(trimmed)) return true;
  if (SIMPLE_NUMERIC_EQUATION.test(trimmed)) return true;
  return /[=^]/.test(trimmed) && /[_\\{}+\-*/]/.test(trimmed);
}

export function isPlausibleParenMath(body: string): boolean {
  const unwrapped = unwrapBalancedParens(body);
  if (unwrapped !== body && isPlausibleParenMath(unwrapped)) return true;
  if (isCommaSeparatedMathAtoms(body)) return true;
  if (SIMPLE_RECIPROCAL.test(body.trim())) return true;
  if (!isPlausibleInlineMath(body)) return false;
  if (SIMPLE_IDENT.test(body)) return body.length === 1;
  if (/\\[A-Za-z]+/.test(body)) return true;
  if (/[\^{}]/.test(body)) return true;
  if (SHORT_SUBSCRIPT.test(body)) return true;
  if (/[<>]=?/.test(body) && /[A-Za-z\\]/.test(body)) return true;
  return /[=+\-*/]/.test(body) && /[_^\\]/.test(body);
}

export function isBareTexParagraph(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > MAX_BODY) return false;
  if (/[\u3400-\u9FFF]/.test(trimmed)) return false;
  if (!/\\[A-Za-z]+/.test(trimmed)) return false;
  if (!/=/.test(trimmed) && !/\\(?:sim|propto|approx|qquad|displaystyle)/.test(trimmed)) {
    return false;
  }
  return proseWords(trimmed).length === 0;
}

export function prepareTex(body: string): string {
  return restoreMarkdownRowSeparators(body)
    .replace(
      /\\(text(?:tt|rm|sf|bf|it)?)\{([^}]*)\}/g,
      (_full, command: string, inner: string) =>
        `\\${command}{${inner.replace(/(?<!\\)[_&]/g, "\\$&")}}`,
    )
    .replace(/(?<!\\)\\X(?![A-Za-z])/g, "X");
}

function restoreMarkdownRowSeparators(body: string): string {
  return restoreMatrixRowSeparators(
    body.replace(
      /\\begin\{(aligned|alignedat)\}[\s\S]*?\\end\{\1\}/g,
      (environment) =>
        environment.replace(/(?<!\\)\\(?=\s+&)/g, "\\\\"),
    ),
  );
}

function restoreMatrixRowSeparators(body: string): string {
  return body.replace(
    /\\begin\{((?:[pbBvV]?matrix|smallmatrix)\*?)\}[\s\S]*?\\end\{\1\}/g,
    (environment) =>
      environment.replace(
        /([^\\\s])([ \t]*)\\(?=(?:\s|[+\-]?(?:\d|\.\d)|[a-zA-MOQT-Y](?![A-Za-z])))/g,
        (_match, previous: string, spacing: string) =>
          `${previous}${spacing}\\\\`,
      ),
  );
}

function unwrapBalancedParens(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return body;
  if (findBalanced(trimmed, "(", ")", 0) !== trimmed.length - 1) return body;
  return trimmed.slice(1, -1);
}

function isCommaSeparatedMathAtoms(body: string): boolean {
  if (!body.includes(",")) return false;
  const parts = body.split(",");
  return parts.length >= 2 && parts.every(isMathAtom);
}

function isMathAtom(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (/\\[A-Za-z]+/.test(trimmed)) return true;
  if (SHORT_SUBSCRIPT.test(trimmed)) return true;
  if (SIMPLE_IDENT.test(trimmed) && trimmed.length <= 2) return true;
  return /^[A-Za-z][A-Za-z0-9]*(\^\{[^}]+\}|\^[A-Za-z0-9]+)$/.test(trimmed);
}

function proseWords(text: string): string[] {
  const stripped = text.replace(/\\[A-Za-z]+/g, " ").replace(/\{[^}]*\}/g, " ");
  return stripped.match(/[A-Za-z]{3,}/g) ?? [];
}

export function findMath(text: string): MathMatch[] {
  const matches: MathMatch[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "(" || next === "[") {
        const display = next === "[";
        const close = display ? "\\]" : "\\)";
        const end = text.indexOf(close, i + 2);
        if (end !== -1) {
          const body = text.slice(i + 2, end);
          if (body.trim().length > 0 && body.length <= MAX_BODY) {
            push(matches, text, i, end + close.length, body, display);
            i = end + close.length;
            continue;
          }
        }
      }
      i += 2;
      continue;
    }

    if (ch === "$") {
      if (text[i + 1] === "$") {
        const end = text.indexOf("$$", i + 2);
        if (end !== -1) {
          const body = text.slice(i + 2, end);
          if (body.trim().length > 0 && body.length <= MAX_BODY) {
            push(matches, text, i, end + 2, body, /[\r\n]/.test(body));
            i = end + 2;
            continue;
          }
        }
        i += 2;
        continue;
      }

      const end = findSingleDollarEnd(text, i + 1);
      if (end !== -1) {
        const body = text.slice(i + 1, end);
        if (isPlausibleInlineMath(body)) {
          push(matches, text, i, end + 1, body, false);
          i = end + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (ch === "[" && text[i + 1] !== "^" && isAtLineStart(text, i)) {
      const end = findDisplayBracketEnd(text, i);
      if (end !== -1) {
        const body = text.slice(i + 1, end);
        if (isPlausibleDisplayMath(body)) {
          push(matches, text, i, end + 1, body.trim(), true);
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === "(" && !isFunctionCallParen(text, i)) {
      const end = findBalanced(text, "(", ")", i);
      if (end !== -1) {
        const body = text.slice(i + 1, end);
        if (isPlausibleParenMath(body)) {
          push(matches, text, i, end + 1, body, false);
          i = end + 1;
          continue;
        }
      }
    }

    i += 1;
  }

  if (matches.length === 0 && isBareTexParagraph(text)) {
    const start = text.search(/\S/);
    if (start >= 0) {
      let end = text.length;
      while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
      push(matches, text, start, end, text.slice(start, end), true);
    }
  }

  return matches;
}

function push(
  matches: MathMatch[],
  text: string,
  start: number,
  end: number,
  body: string,
  display: boolean,
): void {
  matches.push({
    start,
    end,
    body,
    raw: text.slice(start, end),
    display,
  });
}

function isFunctionCallParen(text: string, index: number): boolean {
  if (index === 0) return false;
  return /[A-Za-z0-9}]/.test(text[index - 1] ?? "");
}

function isAtLineStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i -= 1;
  return i < 0 || text[i] === "\n" || text[i] === "\r";
}

function findSingleDollarEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "$" && text[i + 1] !== "$") return i;
  }
  return -1;
}

function findDisplayBracketEnd(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch !== "]") continue;
    if (depth === 1 && isTexRightBracket(text, i)) continue;
    depth -= 1;
    if (depth !== 0) continue;
    if (text[i + 1] === "(") return -1;
    if (isTrailingCloser(text, i)) return i;
    return -1;
  }
  return -1;
}

function isTexRightBracket(text: string, bracketIndex: number): boolean {
  return /\\(?:right|big|Big|bigg|Bigg)[lr]?$/u.test(
    text.slice(0, bracketIndex),
  );
}

function isTrailingCloser(text: string, bracketIndex: number): boolean {
  let i = bracketIndex + 1;
  while (i < text.length && /[ \t\u00a0.,;:!?。，、]/.test(text[i] ?? "")) {
    i += 1;
  }
  return i >= text.length || text[i] === "\n" || text[i] === "\r";
}

function findBalanced(
  text: string,
  open: string,
  close: string,
  from: number,
): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
