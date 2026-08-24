import { esc } from "./format.ts";

/** Small, deliberately limited Markdown renderer for repository-owned specs.
 * It covers the constructs used by spec/strategy/features/*.md without
 * accepting raw HTML. Text is escaped before inline markup is introduced. */

function inlineMarkdown(source: string): string {
  const code: string[] = [];
  let rendered = source.replace(/`([^`]+)`/g, (_match, value: string) => {
    const index = code.push(`<code>${esc(value)}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  rendered = esc(rendered)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // Only feature sections are served. Local repository links therefore
    // explain their target without pretending every path is an HTTP route.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="spec-link" title="$2">$1</span>');
  return rendered.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "");
}

/** Split a table row on its DELIMITERS only. GFM requires a literal pipe inside
 * a cell to be escaped — code spans included — and the specs do exactly that
 * (`spec/strategy/features/dnet.md:27` has `` `BN15 \|\| activeSF15 > 0 …` ``).
 * Splitting on every pipe exploded that 3-column row into seven cells and tore
 * the code span across them, so its backticks printed literally. The trailing
 * strip has to be escape-aware for the same reason, or a cell that legitimately
 * ends in `\|` loses its real delimiter. One helper, so the divider test and the
 * cell split cannot drift apart. */
function rowCells(line: string): string[] {
  return line.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/);
}

function isTableDivider(line: string): boolean {
  const cells = rowCells(line);
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableCells(line: string): string[] {
  // Unescape only AFTER the split, so the backtick pair is back inside one cell
  // and inlineMarkdown's code-span extraction still sees it. Doing this in
  // inlineMarkdown instead would strip `\|` from paragraphs and list items,
  // where the backslash is meaningful text.
  return rowCells(line).map((cell) => inlineMarkdown(cell.trim().replace(/\\\|/g, "|")));
}

/** Where a wrapped continuation line stops. The specs wrap at ~80 columns, so
 * both the paragraph join and the list-item join have to keep consuming until
 * the next block actually starts; sharing one predicate keeps the two loops from
 * drifting apart. */
const BLOCK_START = /^(#{1,4})\s|^```|^\s*[-*]\s|^\s*\d+[.)]\s|^>\s|^---$/;

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.trim() || BLOCK_START.test(line)) return true;
  return line.includes("|") && isTableDivider(lines[index + 1] ?? "");
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^```\s*([^\s]*)/);
    if (fence) {
      const language = fence[1] ? ` class="language-${esc(fence[1])}"` : "";
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) body.push(lines[index++] ?? "");
      if (index < lines.length) index++;
      out.push(`<pre><code${language}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      index++;
      continue;
    }

    if (line.trim() === "---") {
      out.push("<hr>");
      index++;
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        rows.push(tableCells(lines[index++] ?? ""));
      }
      out.push(
        `<div class="spec-table"><table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      );
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = unordered ? "ul" : "ol";
      const marker = unordered ? /^\s*[-*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(marker);
        if (!match) break;
        index++;
        // The item text is not just the marker line. Every spec wraps at ~80
        // columns, and taking only `match[1]` ended the list on the first
        // continuation: it became its own `<p>`, the next bullet opened a fresh
        // `<ul>`, and any `**` or `` ` `` span that opened on the marker line
        // and closed on the wrap leaked its delimiters as literal text. Prose
        // already survives that via the paragraph join below; bullets must too.
        // Indentation is what separates a continuation from the next block, but
        // `startsBlock` is tested FIRST so an indented nested bullet still
        // becomes its own item instead of being glued into its parent's text.
        const text = [match[1]!];
        while (index < lines.length && !startsBlock(lines, index) && /^\s/.test(lines[index] ?? "")) {
          text.push((lines[index++] ?? "").trim());
        }
        // One call on the joined string: that is what repairs a torn span, and
        // it keeps the escaping in one place rather than joining rendered halves.
        items.push(`<li>${inlineMarkdown(text.join(" "))}</li>`);
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) quote.push((lines[index++] ?? "").slice(2));
      out.push(`<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index++;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push((lines[index++] ?? "").trim());
    }
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return out.join("");
}
