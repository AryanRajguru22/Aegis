#!/usr/bin/env node
// Dependency-free repository hygiene check (`npm run lint`).
//
// A conventional ESLint setup is not used: typescript-eslint does not currently resolve
// against this project's TypeScript 7 (npm ERESOLVE), and forcing it would produce an
// unsupported dependency tree. Static analysis is instead provided by `npm run typecheck`
// (strict + noUncheckedIndexedAccess); this script adds the checks a linter would catch
// that actually matter here: focused/leftover tests, debugger statements, committed
// secrets, and tracked local state.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const textExt = /\.(ts|js|mjs|json|md|html|yml|yaml|example|css)$/;
const rules = [
  { name: "focused test (.only)", re: /\b(?:test|it|describe)\.only\s*\(/, only: /\.(ts|js|mjs)$/ },
  { name: "debugger statement", re: /^\s*debugger\s*;?\s*$/m, only: /\.(ts|js|mjs)$/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Anthropic API key", re: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}/ },
  { name: "Stripe live/test secret key", re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
const forbiddenTracked = [/(^|\/)\.env$/, /\.db(-journal|-wal|-shm)?$/, /(^|\/)node_modules\//, /(^|\/)dist\//];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`lint: ${msg}`);
};

for (const f of files) {
  if (forbiddenTracked.some((re) => re.test(f))) fail(`${f}: must not be tracked`);
  if (!textExt.test(f) || f === "scripts/lint.mjs" || f === "package-lock.json") continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const rule of rules) {
    if (rule.only && !rule.only.test(f)) continue;
    if (rule.re.test(text)) fail(`${f}: ${rule.name}`);
  }
}

if (failures > 0) {
  console.error(`lint: ${failures} problem(s)`);
  process.exit(1);
}
console.log(`lint: ${files.length} tracked files checked, no problems`);
