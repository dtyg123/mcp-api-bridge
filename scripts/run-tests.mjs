import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

// `node --test` only learned to expand glob patterns in Node 22, so collect the
// compiled test files explicitly. This keeps `npm test` identical on Node 20/22
// and on Windows, where the shell does not expand globs either.
const dir = path.resolve("dist/test");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(dir, name));

if (files.length === 0) {
  console.error(`No test files found in ${dir}. Run "npm run build" first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
