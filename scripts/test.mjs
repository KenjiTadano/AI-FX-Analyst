import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const output = mkdtempSync(join(tmpdir(), "ai-fx-tests-"));
try {
  const compile = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json", "--outDir", output], { stdio: "inherit" });
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    const test = spawnSync(process.execPath, ["--test", ...readdirSync(join(output, "tests")).filter(file => file.endsWith(".test.js")).map(file => join(output, "tests", file))], { stdio: "inherit" });
    process.exitCode = test.status ?? 1;
    if (!process.exitCode) {
      const legacy = spawnSync(process.execPath, ["tests/market.mjs"], { stdio: "inherit" });
      process.exitCode = legacy.status ?? 1;
    }
  }
} finally { rmSync(output, { recursive: true, force: true }); }
