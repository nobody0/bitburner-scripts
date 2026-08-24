/** In-place DOM patching, so a re-render does not destroy what the operator is
 * doing.
 *
 * Panels are built as HTML strings (see lib/dom.ts) and a live run re-renders
 * twice a second. Assigning that string to `innerHTML` throws away every node
 * in the panel and rebuilds it, which also throws away everything the BROWSER
 * was holding on those nodes and that no amount of application state can name:
 * the text selection, the caret, `:hover` and `:active`, a native tooltip
 * mid-appear, an open `<details>`, a scroll offset, focus. The viewer used to
 * capture and restore a hand-picked subset of that (scroll offsets, the
 * focused input's caret) which is both incomplete — a selection cannot be
 * restored that way at all — and beside the point: none of it needed to be
 * destroyed.
 *
 * So the string is parsed into a detached tree and the LIVE tree is edited to
 * match it. A node whose subtree already equals the new one is not touched at
 * all (`isEqualNode`), which is the common case: a frame usually changes a few
 * numbers in a few cells. Everything the browser owns survives because the
 * nodes carrying it were never replaced.
 *
 * This is deliberately not a virtual DOM. There is no component model, no
 * lifecycle, no reconciliation of application state — just "make this tree
 * look like that one, touching as little as possible". The tabs stay plain
 * string builders. */

/** A canvas's `width`/`height` are set by the chart code from the measured
 * layout, not by the markup that declared it; writing the markup's values back
 * would blank the drawing on every frame. */
const CANVAS_OWNED = new Set(["width", "height"]);

/** Identity for reordering. `id` comes free on the nodes that already have one
 * (search boxes, charts); `data-key` is for a caller that wants a list to
 * reorder rather than be rewritten in place. */
function keyOf(node: Node): string | null {
  if (!(node instanceof Element)) return null;
  return node.getAttribute("data-key") ?? (node.id || null);
}

function compatible(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a instanceof Element && b instanceof Element) {
    return a.tagName === b.tagName && keyOf(a) === keyOf(b);
  }
  return true;
}

function syncAttributes(oldEl: Element, newEl: Element): void {
  const canvas = oldEl.tagName === "CANVAS";
  for (const attr of newEl.attributes) {
    if (canvas && CANVAS_OWNED.has(attr.name)) continue;
    if (oldEl.getAttribute(attr.name) !== attr.value) oldEl.setAttribute(attr.name, attr.value);
  }
  for (const attr of [...oldEl.attributes]) {
    if (newEl.hasAttribute(attr.name)) continue;
    if (canvas && CANVAS_OWNED.has(attr.name)) continue;
    oldEl.removeAttribute(attr.name);
  }
}

/** Form controls keep a "dirty" value once the user has touched them, so the
 * attribute and the property diverge. Push the markup's value onto the
 * property only when the control is NOT focused: the focused one is being
 * typed into, and viewstate already holds what it typed. */
function syncValue(oldEl: Element, newEl: Element): void {
  if (oldEl === oldEl.ownerDocument.activeElement) return;
  if (oldEl instanceof HTMLInputElement && newEl instanceof HTMLInputElement) {
    if (oldEl.type === "checkbox" || oldEl.type === "radio") oldEl.checked = newEl.hasAttribute("checked");
    else if (oldEl.value !== newEl.getAttribute("value")) oldEl.value = newEl.getAttribute("value") ?? "";
  } else if (oldEl instanceof HTMLOptionElement && newEl instanceof HTMLOptionElement) {
    // `selected` is not a reflected property — the content attribute drives
    // `defaultSelected`, and once selectedness is dirty the attribute stops
    // moving it — so an ABSENT attribute means "the panel builder did not state
    // a selection", not "deselect". Clearing it made the run picker's chosen
    // option lose selectedness whenever its own label changed (the live row
    // embeds a duration, so it changes on every catalogue re-send), leaving a
    // single-select to fall back to its first option. The focus guard above
    // cannot cover this: for a `<select>` the activeElement is the SELECT,
    // never the OPTION. Asserting is enough — setting one option true deselects
    // its siblings.
    if (newEl.hasAttribute("selected")) oldEl.selected = true;
  }
}

function patchNode(oldNode: Node, newNode: Node): void {
  // The whole point of the exercise: an unchanged subtree is left alone, so
  // the selection, caret, hover and scroll living inside it are too.
  if (oldNode.isEqualNode(newNode)) return;

  if (!(oldNode instanceof Element) || !(newNode instanceof Element)) {
    if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
    return;
  }

  syncAttributes(oldNode, newNode);
  syncValue(oldNode, newNode);
  // A canvas has no children worth diffing and its bitmap is not in the
  // markup; the chart code redraws it after the patch.
  if (oldNode.tagName === "CANVAS") return;
  patchChildren(oldNode, newNode);
}

function patchChildren(oldParent: Node, newParent: Node): void {
  let oldChild = oldParent.firstChild;
  let newChild = newParent.firstChild;

  while (newChild) {
    const nextNew = newChild.nextSibling;
    if (!oldChild) {
      oldParent.appendChild(newChild);
      newChild = nextNew;
      continue;
    }
    if (compatible(oldChild, newChild)) {
      const nextOld = oldChild.nextSibling;
      patchNode(oldChild, newChild);
      oldChild = nextOld;
      newChild = nextNew;
      continue;
    }
    // Not compatible in place. A keyed node that exists further along the old
    // list is MOVED here rather than rebuilt, which is what makes a re-sorted
    // table keep its nodes (and so its scroll and selection).
    const key = keyOf(newChild);
    const moved = key
      ? [...(oldParent as Element).children].find((child) => child !== oldChild && keyOf(child) === key)
      : undefined;
    if (moved) {
      oldParent.insertBefore(moved, oldChild);
      patchNode(moved, newChild);
    } else {
      oldParent.insertBefore(newChild, oldChild);
    }
    newChild = nextNew;
  }

  while (oldChild) {
    const nextOld = oldChild.nextSibling;
    oldParent.removeChild(oldChild);
    oldChild = nextOld;
  }
}

/** Make `root`'s children match `markup`, touching as few nodes as possible.
 *
 * `<template>` is used to parse because its content is inert — no image
 * fetches, no script execution — and because its parser accepts fragments a
 * plain `<div>` would discard, such as a bare row of `<tr>`s. */
export function morph(root: Element, markup: string): void {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = markup;
  patchChildren(root, template.content);
}
