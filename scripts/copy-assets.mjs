// tsc only emits compiled .ts -> .js; static assets under src/server/public
// (index.html, style.css, favicon.png, vendor/) need a separate copy into
// dist/ since nothing else does it.
import { cpSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
cpSync(join(root, "src", "server", "public"), join(root, "dist", "server", "public"), { recursive: true });
console.log("Copied src/server/public -> dist/server/public");
