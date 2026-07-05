import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The project .env wins over inherited shell env (node --env-file does not
// override existing variables, which bites inside IDE/agent environments).
function loadDotenv() {
  const path = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {
    // no .env — fall back to the inherited environment
  }
  return out;
}

export const cfg = { ...process.env, ...loadDotenv() };
