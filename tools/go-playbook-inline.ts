/** Transform the generated merged playbook module into a classic script.
 *
 * The generated `playbook.phase.js` is a valid ES module, but its size makes
 * esbuild's parser exceed practical memory limits, so it cannot be bundled.
 * The runtime consumers instead inline the source as a plain script after
 * rewriting its module syntax: the export list becomes a
 * `globalThis.__combinedPlaybook` assignment (the bare identifier list is
 * already valid object shorthand) and its standalone `main` entry is renamed
 * out of the way. The transform is anchored to the exact shapes the packer
 * emits and fails loudly on drift.
 */

export const COMBINED_PLAYBOOK_GLOBAL = "__combinedPlaybook";

export function inlinePlaybookScript(moduleSource: string): string {
  // Git's autocrlf can check the generated module out with CRLF endings on
  // Windows; the anchors below assume the packer's LF output.
  moduleSource = moduleSource.replace(/\r\n/g, "\n");
  const exportBlock = /\nexport \{\n/;
  if (!exportBlock.test(moduleSource)) {
    throw new Error("playbook module does not contain the expected export block");
  }
  // The generated module uses top-level await (its packed tables inflate
  // through DecompressionStream), so a classic script must wrap the body in
  // an async IIFE. The export list becomes the IIFE's return value; the
  // renamed standalone entry is a hoisted declaration, so its position after
  // the return is harmless.
  const body = moduleSource
    .replace(exportBlock, "\nreturn {\n")
    .replace(/\nexport async function main\(/, "\nasync function __playbookStandaloneMain(");
  if (/^export\b/m.test(body)) {
    throw new Error("playbook module contains export syntax the inline transform does not cover");
  }
  return `globalThis.${COMBINED_PLAYBOOK_GLOBAL}Ready = (async () => {\n${body}\n})()`
    + `.then((playbook) => (globalThis.${COMBINED_PLAYBOOK_GLOBAL} = playbook));`;
}
