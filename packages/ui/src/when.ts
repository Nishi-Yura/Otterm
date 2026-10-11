/**
 * The `when` conditions of key bindings (docs/06 §5.4), e.g. `terminalFocus && !altScreen` or
 * `guideLevel >= 2`. A small recursive-descent parser; no eval.
 */

/** The state a condition reads; a name that is not in it is undefined. */
export type WhenContext = Record<string, boolean | number | string | undefined>;

type Value = boolean | number | string | undefined;
type Eval = (ctx: WhenContext) => Value;

interface Token {
  kind: "id" | "num" | "str" | "op";
  text: string;
}

const OPS = ["&&", "||", "==", "!=", ">=", "<=", "!", "<", ">", "(", ")"];

/** Splits the text into tokens; `undefined` for a character that starts no token. */
function tokenize(text: string): Token[] | undefined {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = rest.charAt(0);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = rest.indexOf(c, 1);
      if (end < 0) return undefined;
      out.push({ kind: "str", text: rest.slice(1, end) });
      i += end + 1;
      continue;
    }
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) {
      out.push({ kind: "op", text: op });
      i += op.length;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(rest);
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    const m = num ?? id;
    if (!m) return undefined;
    out.push({ kind: num ? "num" : "id", text: m[0] });
    i += m[0].length;
  }
  return out;
}

function truthy(v: Value): boolean {
  if (v === undefined) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return v;
}

/** A comparison; anything against an undefined name is false, and mixed types are only unequal. */
function compare(op: string, a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return false;
  const x = typeof a === "boolean" ? Number(a) : a;
  const y = typeof b === "boolean" ? Number(b) : b;
  let c: number;
  if (typeof x === "number" && typeof y === "number") c = x === y ? 0 : x < y ? -1 : 1;
  else if (typeof x === "string" && typeof y === "string") c = x === y ? 0 : x < y ? -1 : 1;
  else return op === "!=";
  switch (op) {
    case "==":
      return c === 0;
    case "!=":
      return c !== 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
    case "<":
      return c < 0;
    default:
      return c <= 0;
  }
}

/**
 * Parses a condition. Precedence, loosest first: `||`, `&&`, comparisons, `!`. Returns `undefined`
 * for a syntax error.
 */
export function compileWhen(text: string): ((ctx: WhenContext) => boolean) | undefined {
  const toks = tokenize(text);
  if (!toks || toks.length === 0) return undefined;
  let pos = 0;
  const peekOp = (...ops: string[]): string | undefined => {
    const t = toks[pos];
    return t?.kind === "op" && ops.includes(t.text) ? t.text : undefined;
  };
  const eat = (op: string): boolean => {
    if (peekOp(op) === undefined) return false;
    pos++;
    return true;
  };

  const primary = (): Eval => {
    const t = toks[pos++];
    if (!t) throw new Error("when: unexpected end");
    if (t.kind === "op" && t.text === "(") {
      const inner = orExpr();
      if (!eat(")")) throw new Error("when: missing )");
      return inner;
    }
    if (t.kind === "num") {
      const n = Number(t.text);
      return () => n;
    }
    if (t.kind === "str") {
      const s = t.text;
      return () => s;
    }
    if (t.kind === "id") {
      const name = t.text;
      return (ctx) => (Object.hasOwn(ctx, name) ? ctx[name] : undefined);
    }
    throw new Error("when: unexpected token");
  };
  const unary = (): Eval => {
    if (eat("!")) {
      const operand = unary();
      return (ctx) => !truthy(operand(ctx));
    }
    return primary();
  };
  const comparison = (): Eval => {
    const left = unary();
    const op = peekOp("==", "!=", ">=", "<=", ">", "<");
    if (op === undefined) return left;
    pos++;
    const right = unary();
    return (ctx) => compare(op, left(ctx), right(ctx));
  };
  const andExpr = (): Eval => {
    let left = comparison();
    while (eat("&&")) {
      const l = left;
      const r = comparison();
      left = (ctx) => truthy(l(ctx)) && truthy(r(ctx));
    }
    return left;
  };
  function orExpr(): Eval {
    let left = andExpr();
    while (eat("||")) {
      const l = left;
      const r = andExpr();
      left = (ctx) => truthy(l(ctx)) || truthy(r(ctx));
    }
    return left;
  }

  try {
    const expr = orExpr();
    if (pos !== toks.length) return undefined;
    return (ctx) => truthy(expr(ctx));
  } catch {
    return undefined;
  }
}
