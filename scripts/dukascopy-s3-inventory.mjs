import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const output = mkdtempSync(join(tmpdir(), "task116-inventory-operator-"));
let child;
let interrupted = false;
const forwardInt = () => {
  interrupted = true;
  child?.kill("SIGINT");
};
const forwardTerm = () => {
  interrupted = true;
  child?.kill("SIGTERM");
};
process.on("SIGINT", forwardInt);
process.on("SIGTERM", forwardTerm);

try {
  const config = ts.readConfigFile(join(projectRoot, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent({ ...config.config, include: ["lib/backtest/dukascopy-inventory-cli.ts"], exclude: ["node_modules"] }, ts.sys, projectRoot, { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, noEmit: false, incremental: false, outDir: output, rootDir: projectRoot, plugins: [] });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  if (config.error || parsed.errors.length || ts.getPreEmitDiagnostics(program).some((item) => item.category === ts.DiagnosticCategory.Error) || program.emit().emitSkipped) throw new Error("COMPILATION_FAILED");
  await new Promise((resolve) => setImmediate(resolve));
  if (interrupted) throw new Error("CANCELLED");
  const entry = join(output, "lib/backtest/dukascopy-inventory-cli.js");
  const script = `require(${JSON.stringify(entry)}).runInventoryOperatorCli(process.argv.slice(1), value => console.log(JSON.stringify(value, null, 2))).then(code => { process.exitCode = code; }).catch(() => { console.error('OPERATOR_ERROR'); process.exitCode = 1; });`;
  child = spawn(process.execPath, ["-e", script, "--", ...process.argv.slice(2)], { cwd: projectRoot, stdio: "inherit", env: { ...process.env, NODE_PATH: [join(projectRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter) } });
  process.exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
} catch {
  console.error(interrupted ? "INVENTORY_CANCELLED" : "INVENTORY_OPERATOR_STARTUP_FAILED");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", forwardInt);
  process.off("SIGTERM", forwardTerm);
  rmSync(output, { recursive: true, force: true });
}
