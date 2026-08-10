/** Markup that is already escaped, and the tagged template that produces it.
 *
 * The viewer builds panels as HTML strings, which means every slot is one of
 * two kinds: a RAW slot that expects markup (a table cell, a card body) or a
 * TEXT slot that expects prose and escapes it (a note, a tile value, a
 * tooltip). A plain `string` cannot tell the two apart, and the whole class of
 * bugs this file exists to close came from that: a caller writing
 * `note("book is <b>flat</b>")` got `&lt;b&gt;` printed at the operator, while
 * a caller writing `note(\`x: ${esc(v)}\`)` got the value escaped twice and an
 * `&amp;quot;` in the middle of a server name.
 *
 * `Html` is the marker that says "this string is already markup". A text slot
 * passes it through untouched and escapes everything else, so the SAFE thing
 * stays the default and emitting markup is a deliberate act:
 *
 *     note("plain prose")                  // escaped, as it must be
 *     note(html`book is <b>flat</b>`)      // markup, on purpose
 *     note(html`unknown: ${reason}`)       // markup, and `reason` is escaped
 *
 * Interpolations inside html`` are escaped unless they are themselves `Html`,
 * so nested fragments compose without either double-escaping or a hole. */

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Anything a slot can render: prose to be escaped, or markup already built. */
export type Markup = string | Html;

/** Every value interpolated into a template goes through this. Telemetry
 * payloads are game-controlled strings (server names, faction names, error
 * messages); none of it should be able to inject markup into the viewer. */
export function escapeText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Trust a string that is already markup. The escape hatch for fragments built
 * outside a template; prefer html`` , which escapes for you. */
export function raw(value: string): Html {
  return new Html(value);
}

/** Render a value bound for a TEXT slot: markup as-is, everything else
 * escaped. */
export function inline(value: Markup | undefined | null): string {
  return value instanceof Html ? value.value : escapeText(value);
}

function interpolate(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeText(value);
}

/** Tagged template producing markup: the literal parts are trusted, every
 * interpolation is escaped unless it is already `Html`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index++) {
    out += interpolate(values[index]) + (strings[index + 1] ?? "");
  }
  return new Html(out);
}
