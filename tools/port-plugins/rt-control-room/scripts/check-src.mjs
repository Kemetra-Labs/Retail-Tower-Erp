// react-dom itself contains innerHTML, so this guard runs on src/, not on dist/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const FORBIDDEN = ["innerHTML", "outerHTML", "dangerouslySetInnerHTML"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const problems = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const word of FORBIDDEN) {
    if (text.includes(word)) problems.push(`${relative(ROOT, file)} contains ${word}`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`src FAIL ${p}`);
  process.exit(1);
}
console.log("src ok");
