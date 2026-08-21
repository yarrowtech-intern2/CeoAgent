// One-off script used to (re)generate vendor/fonts/onest/ — not part of the
// build. Re-run manually if Onest needs a version bump (see VERSIONS.md).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "src", "server", "public", "vendor", "fonts", "onest");
const src = readFileSync(join(dir, "onest-source.css"), "utf-8");

// Keep latin + latin-ext only (this is an English-language business app) —
// drops cyrillic/cyrillic-ext to cut vendored font size roughly in half.
const entries = [];
const lines = src.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("/*")) {
    const subset = lines[i];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("}")) j++;
    entries.push({ subset, block: lines.slice(i, j + 1).join("\n") });
    i = j;
  }
}
const wanted = entries.filter((e) => e.subset === "/* latin */" || e.subset === "/* latin-ext */");

const urlRe = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/;
let css = "";
for (const { block } of wanted) {
  const m = block.match(urlRe);
  if (!m) continue;
  const url = m[1];
  const filename = url.split("/").pop();
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(dir, filename), buf);
  css += block.replace(url, `./${filename}`) + "\n";
}
writeFileSync(join(dir, "onest.css"), css);
console.log(`Wrote onest.css + ${wanted.length} woff2 files`);
