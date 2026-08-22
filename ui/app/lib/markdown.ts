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

function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdown(cell.trim()));
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
      const items: string[] = [];
      while (index < lines.length) {
        const match = unordered
          ? (lines[index] ?? "").match(/^\s*[-*]\s+(.+)$/)
          : (lines[index] ?? "").match(/^\s*\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${inlineMarkdown(match[1]!)}</li>`);
        index++;
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
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim() || /^(#{1,4})\s|^```|^\s*[-*]\s|^\s*\d+[.)]\s|^>\s|^---$/.test(next)) break;
      if (next.includes("|") && isTableDivider(lines[index + 1] ?? "")) break;
      paragraph.push(next.trim());
      index++;
    }
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return out.join("");
}
