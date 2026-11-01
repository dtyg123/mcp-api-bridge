// Copies non-TypeScript assets (the admin UI) into dist/ after tsc.
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "web");
const to = path.join(root, "dist", "src", "web");

await mkdir(path.dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
process.stdout.write(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}\n`);
