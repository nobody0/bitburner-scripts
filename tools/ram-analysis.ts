/** Faithful port of Bitburner's static RAM analyzer for built artifacts.
 *
 * Mirrors `parseOnlyRamCalculate` from bitburner-src
 * src/Script/RamCalculations.ts @ v3.0.1 (3162fd2), restricted to a single
 * self-contained module — exactly what our bundles are. The cost table is the
 * transcription the simulator already pins against upstream
 * (sim/ns/ram-costs.ts).
 *
 * Fidelity notes, all matching upstream:
 * - Every bare identifier and every non-computed property name is a
 *   "reference"; each unique reference matching any key anywhere in the cost
 *   tree is billed once. Bracket access with a string literal is invisible —
 *   that is the entire dodge mechanism.
 * - `window`/`document` references cost RamCostConstants.Dom each.
 * - A top-level `function main` whose first statement is
 *   `ns.ramOverride(<numeric literal>)` short-circuits the whole calculation
 *   to that literal. The build appends a decoy declaration to keep this
 *   recognisable after identifier minification (tools/build.ts).
 */
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { RAM_COSTS, SCRIPT_BASE_RAM_GB, type RamCostContext } from "../sim/ns/ram-costs.ts";

/** RamCostConstants.Dom @ v3.0.1; not part of the transcribed tree because no
 * ns function prices it — it applies only to the window/document specials. */
const DOM_GB = 25;
/** RamCostConstants.Max @ v3.0.1. */
const MAX_GB = 1024;

type CostNode = number | { sf4: number } | { [key: string]: CostNode };

function isSf4(node: CostNode): node is { sf4: number } {
  return typeof node === "object" && typeof (node as { sf4?: number }).sf4 === "number";
}

/** SF4Cost multiplier, mirroring sim/ns/ram-costs.ts sf4Multiplier. */
function sf4Multiplier(ctx: RamCostContext): number {
  if (ctx.bitNode === 4) return 1;
  const level = ctx.sf4Level ?? 0;
  return level >= 3 ? 1 : level === 2 ? 4 : 16;
}

/** Depth-first search for `ref` as a key anywhere in the cost tree, in entry
 * order — upstream's findFunc. Namespaces (plain objects) are recursed into,
 * never billed themselves. */
function findCost(node: CostNode, ref: string, ctx: RamCostContext): number | undefined {
  if (typeof node !== "object" || isSf4(node)) return undefined;
  const own = node[ref];
  if (own !== undefined && (typeof own === "number" || isSf4(own))) {
    return typeof own === "number" ? own : own.sf4 * sf4Multiplier(ctx);
  }
  for (const value of Object.values(node)) {
    const found = findCost(value, ref, ctx);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every billable name in the cost tree (leaf keys), plus the DOM specials.
 * This is the vocabulary a build-surface comparison has to preserve. */
export function billableRamNames(): Set<string> {
  const names = new Set<string>(["window", "document"]);
  const collect = (node: CostNode): void => {
    if (typeof node !== "object" || isSf4(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "number" || isSf4(value)) names.add(key);
      else collect(value);
    }
  };
  collect(RAM_COSTS);
  return names;
}

export interface RamAnalysis {
  cost: number;
  /** Billed references, most expensive first. An override yields the single
   * entry `override`. */
  entries: { name: string; cost: number }[];
  /** True when a syntactic main-declaration ramOverride ended the walk. */
  overridden: boolean;
}

const memCheckGlobalKey = ".__GLOBAL__";
const specialReferenceRAM = ".^SPECIAL_ramOverride";

/** Static RAM of one self-contained ESM bundle, exactly as the game bills it.
 * Throws if the module has imports — our artifacts never do, and silently
 * mispricing an import graph would defeat the point. */
export function analyzeScriptRam(code: string, ctx: RamCostContext = {}, moduleName = "script.js"): RamAnalysis {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const dependencyMap: Record<string, Set<string>> = {};
  const globalKey = moduleName + memCheckGlobalKey;
  dependencyMap[globalKey] = new Set<string>();

  function addRef(key: string, name: string): void {
    const s = dependencyMap[key] ?? (dependencyMap[key] = new Set());
    s.add(moduleName + "." + name);
    s.add(name);
  }

  function checkRamOverride(body: acorn.BlockStatement): void {
    const statement = body.body?.[0];
    if (statement?.type !== "ExpressionStatement") return;
    const expr = statement.expression;
    if (expr.type !== "CallExpression" || expr.arguments.length !== 1) return;
    let callee: acorn.Expression | acorn.Super | acorn.PrivateIdentifier = expr.callee;
    for (;;) {
      if (callee.type === "ParenthesizedExpression" || callee.type === "ChainExpression") callee = callee.expression;
      else if (callee.type === "MemberExpression") callee = callee.property;
      else break;
    }
    if (callee.type !== "Identifier" || callee.name !== "ramOverride") return;
    const literal = expr.arguments[0];
    if (literal?.type !== "Literal" || typeof literal.value !== "number") return;
    const value = literal.value;
    if (!isFinite(value) || value < SCRIPT_BASE_RAM_GB) return;
    dependencyMap[moduleName + specialReferenceRAM] = new Set([String(Math.round(value * 100) / 100)]);
  }

  const objectPrototypeProperties = Object.getOwnPropertyNames(Object.prototype);
  interface State { key: string }

  function commonVisitors(): walk.RecursiveVisitors<State> {
    const loop = (name: string) =>
      (node: { test?: acorn.Node | null; body?: acorn.Node | null; init?: acorn.Node | null; update?: acorn.Node | null; consequent?: acorn.Node | null; alternate?: acorn.Node | null }, st: State, walkDeeper: walk.WalkerCallback<State>) => {
        addRef(st.key, name);
        for (const part of [node.init, node.test, node.update, node.body, node.consequent, node.alternate]) {
          if (part) walkDeeper(part as acorn.Expression, st);
        }
      };
    return {
      Identifier: (node: acorn.Identifier, st: State) => {
        if (objectPrototypeProperties.includes(node.name)) return;
        addRef(st.key, node.name);
      },
      WhileStatement: loop("__SPECIAL_referenceWhile"),
      DoWhileStatement: loop("__SPECIAL_referenceWhile"),
      ForStatement: loop("__SPECIAL_referenceFor"),
      IfStatement: loop("__SPECIAL_referenceIf"),
      MemberExpression: (node: acorn.MemberExpression, st: State, walkDeeper: walk.WalkerCallback<State>) => {
        walkDeeper(node.object, st);
        walkDeeper(node.property, st);
      },
    };
  }

  walk.recursive<State>(
    ast as unknown as acorn.Node,
    { key: globalKey },
    Object.assign(
      {
        ImportDeclaration: () => {
          throw new Error("analyzeScriptRam expects a self-contained bundle without imports");
        },
        FunctionDeclaration: (node: acorn.FunctionDeclaration) => {
          if (node.id?.name === "main") checkRamOverride(node.body);
          const key = moduleName + "." + (node.id === null ? "__SPECIAL_DEFAULT_EXPORT__" : node.id.name);
          walk.recursive(node, { key }, commonVisitors());
        },
        ExportNamedDeclaration: (node: acorn.ExportNamedDeclaration, st: State, walkDeeper: walk.WalkerCallback<State>) => {
          if (node.declaration != null) {
            walkDeeper(node.declaration, st);
            return;
          }
          for (const specifier of node.specifiers) {
            if (specifier.exported.type !== "Identifier" || specifier.local.type !== "Identifier") continue;
            if (specifier.exported.name !== specifier.local.name) {
              addRef(moduleName + "." + specifier.exported.name, specifier.local.name);
            }
          }
        },
      },
      commonVisitors(),
    ),
  );

  let ram = SCRIPT_BASE_RAM_GB;
  const entries: { name: string; cost: number }[] = [];
  const unresolvedRefs = Object.keys(dependencyMap).filter((s) => s.startsWith(moduleName));
  const resolvedRefs = new Set<string>();
  const billed = new Set<string>();
  while (unresolvedRefs.length > 0) {
    const ref = unresolvedRefs.shift()!;
    if (ref.endsWith(specialReferenceRAM)) {
      if (ref !== moduleName + specialReferenceRAM) continue;
      const [first] = dependencyMap[ref]!;
      const override = Number(first);
      return { cost: override, entries: [{ name: "override", cost: override }], overridden: true };
    }
    if ((ref === "document" || ref === "window") && !resolvedRefs.has(ref)) {
      ram += DOM_GB;
      entries.push({ name: ref, cost: DOM_GB });
    }
    resolvedRefs.add(ref);
    for (const dep of dependencyMap[ref] ?? []) {
      if (!resolvedRefs.has(dep)) unresolvedRefs.push(dep);
    }
    if (billed.has(ref)) continue;
    billed.add(ref);
    const cost = findCost(RAM_COSTS, ref, ctx);
    if (cost !== undefined && cost > 0) {
      ram += cost;
      entries.push({ name: ref, cost });
    }
  }
  return {
    cost: Math.min(ram, MAX_GB),
    entries: entries.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)),
    overridden: false,
  };
}
