// Minimal safe math expression evaluator — no eval()/Function() on untrusted input.
// Supports the subset described to the model in visual.ts's plot_function tool:
// + - * / ^, unary minus, parentheses, implicit multiplication ("2x", "x(x - 2)",
// "3sin(x)"), and sin/cos/tan/sqrt/abs/log/ln/exp, with `x` as the only variable.
// Recursive-descent parser over a token stream.
//
// Two conventions are SPM's, not a programmer's, and both have bitten before:
// - Unary minus binds LOOSER than ^, so "-x^2" is -(x²). The first version parsed
//   it as (-x)², which drew y = -x² + 4 opening upward.
// - `log` is base 10 and `ln` is natural, as in the KSSM textbooks. The first
//   version mapped `log` to Math.log, so log graphs were off by a factor of 2.3.

type TokenType = "number" | "identifier" | "op" | "lparen" | "rparen" | "comma";
interface Token {
  type: TokenType;
  value: string;
}

export type AngleUnit = "radians" | "degrees";

const TRIG = new Set(["sin", "cos", "tan"]);
const FUNCTIONS: Record<string, (n: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
};
// Longest first, so "sqrt" isn't read as "s"+"qrt" and "exp" isn't "e"+"xp".
const NAMES = ["sqrt", "sin", "cos", "tan", "abs", "log", "exp", "ln", "pi", "x", "e"];

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  const src = expr.replace(/π/g, "pi").replace(/[×·]/g, "*").replace(/[−–]/g, "-");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: "number", value: src.slice(i, j) });
      i = j;
    } else if (/[a-zA-Z]/.test(c)) {
      // A letter run like "xsin" or "2pix" is split into known names, so the
      // implicit multiplication below sees separate factors.
      let j = i;
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      let word = src.slice(i, j).toLowerCase();
      while (word) {
        const name = NAMES.find((n) => word.startsWith(n));
        if (!name) throw new Error(`Unknown identifier "${word}"`);
        tokens.push({ type: "identifier", value: name });
        word = word.slice(name.length);
      }
      i = j;
    } else if ("+-*/^".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
    } else if (c === "(") {
      tokens.push({ type: "lparen", value: c });
      i++;
    } else if (c === ")") {
      tokens.push({ type: "rparen", value: c });
      i++;
    } else if (c === ",") {
      tokens.push({ type: "comma", value: c });
      i++;
    } else {
      throw new Error(`Unexpected character "${c}" in expression`);
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  private x: number;
  private degrees: boolean;

  constructor(tokens: Token[], x: number, degrees: boolean) {
    this.tokens = tokens;
    this.x = x;
    this.degrees = degrees;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(type?: TokenType): Token {
    const t = this.tokens[this.pos];
    if (!t || (type && t.type !== type)) {
      throw new Error(`Unexpected end of expression`);
    }
    this.pos++;
    return t;
  }

  parse(): number {
    const value = this.parseAddSub();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token "${this.peek()?.value}"`);
    }
    return value;
  }

  private parseAddSub(): number {
    let value = this.parseMulDiv();
    while (this.peek()?.type === "op" && (this.peek()?.value === "+" || this.peek()?.value === "-")) {
      const op = this.consume().value;
      const rhs = this.parseMulDiv();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseMulDiv(): number {
    let value = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.type === "op" && (t.value === "*" || t.value === "/")) {
        this.consume();
        const rhs = this.parseUnary();
        value = t.value === "*" ? value * rhs : value / rhs;
      } else if (t && (t.type === "number" || t.type === "identifier" || t.type === "lparen")) {
        // Implicit multiplication: "2x", "x(x - 2)", "(x + 1)(x - 1)".
        value *= this.parsePow();
      } else {
        return value;
      }
    }
  }

  private parseUnary(): number {
    if (this.peek()?.type === "op" && this.peek()?.value === "-") {
      this.consume();
      return -this.parseUnary();
    }
    if (this.peek()?.type === "op" && this.peek()?.value === "+") {
      this.consume();
      return this.parseUnary();
    }
    return this.parsePow();
  }

  private parsePow(): number {
    const base = this.parseAtom();
    if (this.peek()?.type === "op" && this.peek()?.value === "^") {
      this.consume();
      const exponent = this.parseUnary(); // right-associative, and allows x^-1
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseAtom(): number {
    const token = this.peek();
    if (!token) throw new Error("Unexpected end of expression");

    if (token.type === "number") {
      this.consume();
      return parseFloat(token.value);
    }
    if (token.type === "lparen") {
      this.consume();
      const value = this.parseAddSub();
      this.consume("rparen");
      return value;
    }
    if (token.type === "identifier") {
      this.consume();
      const name = token.value;
      if (name === "x") return this.x;
      if (name === "pi") return Math.PI;
      if (name === "e") return Math.E;
      const fn = FUNCTIONS[name];
      if (!fn) throw new Error(`Unknown identifier "${name}"`);
      // Parentheses are required: "sin 2x" is sin(2x) to a student but would
      // parse as sin(2)·x, so it is rejected rather than drawn wrong.
      if (this.peek()?.type !== "lparen") throw new Error(`"${name}" needs brackets, e.g. ${name}(x)`);
      this.consume();
      const arg = this.parseAddSub();
      this.consume("rparen");
      return fn(this.degrees && TRIG.has(name) ? (arg * Math.PI) / 180 : arg);
    }
    throw new Error(`Unexpected token "${token.value}"`);
  }
}

/** Parses `expr` once and returns a function of x. Throws on invalid syntax or
 * unknown identifiers, so a bad expression fails before any plotting starts. */
export function compileExpr(expr: string, angleUnit: AngleUnit = "radians"): (x: number) => number {
  const tokens = tokenize(expr);
  const degrees = angleUnit === "degrees";
  new Parser(tokens, 1, degrees).parse(); // syntax check
  return (x: number) => new Parser(tokens, x, degrees).parse();
}

/** Evaluates `expr` (a function of `x`) at a single point. Throws on invalid syntax
 * or unknown identifiers — callers should catch and skip that point/plot. */
export function evaluateExpr(expr: string, x: number, angleUnit: AngleUnit = "radians"): number {
  return new Parser(tokenize(expr), x, angleUnit === "degrees").parse();
}
