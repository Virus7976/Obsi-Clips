// Bundles each test file (TypeScript) so node --test can run it.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "node:fs";

rmSync("test-out", { recursive: true, force: true });
const files = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => "test/" + f);
await esbuild.build({ entryPoints: files, bundle: true, platform: "node", format: "esm", outdir: "test-out", outExtension: { ".js": ".mjs" }, logLevel: "warning" });
