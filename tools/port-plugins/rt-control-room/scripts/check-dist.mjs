// Fails when the built widget breaks the Port upload rules or the size budget.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAX_BYTES = 1572864; // 1.5 MiB
const ALLOWED_HOSTS = ["www.w3.org", "reactjs.org", "react.dev"];
const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.html");

const problems = [];
let size = 0;
let html = "";
try {
  size = statSync(FILE).size;
  html = readFileSync(FILE, "utf8");
} catch {
  console.error("dist FAIL dist/index.html is missing, run npm run build first");
  process.exit(1);
}

if (size > MAX_BYTES) problems.push(`size ${size} is over ${MAX_BYTES} bytes`);
if (html.includes("Function(")) problems.push("contains Function(");
if (html.includes("fonts.googleapis")) problems.push("contains fonts.googleapis");
// Arabic mode is RTL: the build must keep CSS logical properties, not rewrite them to left/right.
for (const prop of ["padding-inline-start", "margin-inline", "inset-inline"]) {
  if (!html.includes(prop)) problems.push(`CSS logical property ${prop} missing (RTL would mirror wrongly)`);
}
// The inline-script plugin must escape </script inside the bundle: exactly one closing tag: the single inlined bundle. A second one means an unescaped </script inside it.
if ((html.match(/<\/script/gi) || []).length !== 1) problems.push("expected exactly one </script (an unescaped </script inside the inlined bundle?)");

const hosts = new Set();
for (const m of html.matchAll(/https?:\/\/([^\s"'`\/)<>]+)/g)) hosts.add(m[1].toLowerCase());
for (const host of hosts) {
  if (!ALLOWED_HOSTS.includes(host)) problems.push(`URL host not allowed: ${host}`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`dist FAIL ${p}`);
  process.exit(1);
}
console.log(`dist ok ${size}`);
