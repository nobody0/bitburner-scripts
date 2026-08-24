import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/** The viewer patches its panels in place instead of reassigning `innerHTML`,
 * because everything the browser holds on a node — the text selection, the
 * caret, hover, an open disclosure, a scroll offset — dies with that node, and
 * a live run re-renders twice a second. These tests pin the property that
 * makes that work: a node whose markup did not change is the SAME node
 * afterwards. */

GlobalRegistrator.register();
const { morph } = await import("../ui/app/lib/morph.ts");

let root: HTMLElement;

beforeAll(() => {
  root = document.createElement("main");
  document.body.appendChild(root);
});

afterAll(() => {
  void GlobalRegistrator.unregister();
});

function render(markup: string): void {
  morph(root, markup);
}

describe("morph", () => {
  test("builds the tree on a first patch", () => {
    root.replaceChildren();
    render(`<section class="card"><h2>Hacking</h2><p>ready</p></section>`);
    expect(root.querySelector("h2")?.textContent).toBe("Hacking");
    expect(root.querySelector("p")?.textContent).toBe("ready");
  });

  test("an unchanged subtree keeps its identity across a re-render", () => {
    root.replaceChildren();
    render(`<div><span id="a">1</span><span id="b">2</span></div>`);
    const a = root.querySelector("#a")!;
    const b = root.querySelector("#b")!;
    render(`<div><span id="a">1</span><span id="b">99</span></div>`);
    // `a` did not change, so it was never touched; `b` is the same node with
    // new text rather than a replacement.
    expect(root.querySelector("#a")).toBe(a);
    expect(root.querySelector("#b")).toBe(b);
    expect(b.textContent).toBe("99");
  });

  test("an open disclosure survives a frame that does not close it", () => {
    root.replaceChildren();
    render(`<details data-open-key="x" open><summary>s</summary><p>1</p></details>`);
    const details = root.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    render(`<details data-open-key="x" open><summary>s</summary><p>2</p></details>`);
    expect(root.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
  });

  test("markup that drops `open` closes the disclosure", () => {
    root.replaceChildren();
    render(`<details data-open-key="x" open><summary>s</summary></details>`);
    render(`<details data-open-key="x"><summary>s</summary></details>`);
    expect((root.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  });

  test("attributes are added, changed and removed", () => {
    root.replaceChildren();
    render(`<a class="tab on" href="#/x" title="t">x</a>`);
    const link = root.querySelector("a")!;
    render(`<a class="tab" href="#/x">x</a>`);
    expect(root.querySelector("a")).toBe(link);
    expect(link.getAttribute("class")).toBe("tab");
    expect(link.hasAttribute("title")).toBe(false);
  });

  test("a focused input is not reset from markup while it is being typed into", () => {
    root.replaceChildren();
    render(`<input id="search-hacking" value="" />`);
    const input = root.querySelector("input") as HTMLInputElement;
    input.focus();
    input.value = "n00d";
    // The frame this keystroke triggered still carries the previous value.
    render(`<input id="search-hacking" value="n00" />`);
    expect(root.querySelector("input")).toBe(input);
    expect(input.value).toBe("n00d");
  });

  test("an unfocused input does take the value the markup declares", () => {
    root.replaceChildren();
    render(`<input id="q" value="old" />`);
    const input = root.querySelector("input") as HTMLInputElement;
    input.blur();
    render(`<input id="q" value="new" />`);
    expect(input.value).toBe("new");
  });

  test("a select keeps its selection when an option's label changes", () => {
    root.replaceChildren();
    // The run picker's live row embeds a duration, so the selected option's own
    // markup changes on every catalogue re-send. `selected` is not a reflected
    // property, so an absent attribute must not be read as "deselect".
    render(`<select id="runpick"><option data-key="a" value="a">a 1s</option>` +
      `<option data-key="b" value="b">b 1s</option></select>`);
    const select = root.querySelector("select") as HTMLSelectElement;
    select.value = "b";
    render(`<select id="runpick"><option data-key="a" value="a">a 1s</option>` +
      `<option data-key="b" value="b">b 2s</option></select>`);
    expect(root.querySelector("select")).toBe(select);
    expect(select.value).toBe("b");
  });

  test("markup that declares `selected` moves the selection", () => {
    root.replaceChildren();
    render(`<select id="p"><option value="a">a</option><option value="b">b</option></select>`);
    const select = root.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("a");
    render(`<select id="p"><option value="a">a</option><option value="b" selected>b</option></select>`);
    expect(select.value).toBe("b");
  });

  test("a keyed child that moved is moved, not rebuilt", () => {
    root.replaceChildren();
    render(`<div><p data-key="a">a</p><p data-key="b">b</p><p data-key="c">c</p></div>`);
    const a = root.querySelector('[data-key="a"]')!;
    const c = root.querySelector('[data-key="c"]')!;
    render(`<div><p data-key="c">c</p><p data-key="b">b</p><p data-key="a">a</p></div>`);
    expect(root.querySelector('[data-key="c"]')).toBe(c);
    expect(root.querySelector('[data-key="a"]')).toBe(a);
    expect([...root.querySelectorAll("p")].map((p) => p.getAttribute("data-key"))).toEqual(["c", "b", "a"]);
  });

  test("a canvas keeps the size the chart code measured onto it", () => {
    root.replaceChildren();
    render(`<canvas id="chart"></canvas><span>0</span>`);
    const canvas = root.querySelector("canvas") as HTMLCanvasElement;
    canvas.width = 640;
    canvas.height = 200;
    render(`<canvas id="chart"></canvas><span>1</span>`);
    expect(root.querySelector("canvas")).toBe(canvas);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(200);
  });

  test("a selection over text the frame did not change survives it", () => {
    root.replaceChildren();
    render(`<div><p id="prose">the arbiter denied hacknet</p><span id="clock">0s</span></div>`);
    const prose = root.querySelector("#prose")!.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(prose, 4);
    range.setEnd(prose, 11);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("arbiter");
    // A live frame: the clock moved, the prose did not.
    render(`<div><p id="prose">the arbiter denied hacknet</p><span id="clock">1s</span></div>`);
    expect(selection.toString()).toBe("arbiter");
  });

  test("nodes the new markup drops are removed", () => {
    root.replaceChildren();
    render(`<div><p>1</p><p>2</p><p>3</p></div>`);
    render(`<div><p>1</p></div>`);
    expect(root.querySelectorAll("p").length).toBe(1);
  });

  test("a table row's cells are patched in place", () => {
    root.replaceChildren();
    render(`<table><tbody><tr><td>home</td><td>$1</td></tr></tbody></table>`);
    const row = root.querySelector("tr")!;
    const host = row.children[0]!;
    render(`<table><tbody><tr><td>home</td><td>$2</td></tr></tbody></table>`);
    expect(root.querySelector("tr")).toBe(row);
    expect(row.children[0]).toBe(host);
    expect(row.children[1]?.textContent).toBe("$2");
  });
});
