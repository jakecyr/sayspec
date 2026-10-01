#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { JevClient } from "./jev.js";
import { LlmClient, type LlmProvider } from "./llm.js";
import { Runner } from "./runner.js";
import { findSpec, loadSpec } from "./spec.js";
import type { ArtifactMode, BrowserName } from "./types.js";

const program = new Command()
  .name("sayspec")
  .description("Run natural-language browser tests with a Jev or LLM classifier and Playwright")
  .version("0.1.0")
  .argument("[spec]", "YAML/JSON suite file or directory; otherwise searches parent directories")
  .option("--init", "write a starter sayspec.yaml in the current directory")
  .option("--headed", "show the browser")
  .option("--browser <name>", "chromium, firefox, webkit, or brave")
  .option("--cdp <url>", "attach to a Chromium/Brave remote-debugging endpoint")
  .option("--executable-path <path>", "browser executable override")
  .option("--user-data-dir <path>", "persistent browser profile directory")
  .option("--artifacts <mode>", "always, failure, or off")
  .option("--artifact-root <path>", "artifact output directory", "artifacts")
  .option("--workers <count>", "maximum number of dependency-ready tests to run in parallel")
  .option("--json <path>", "write the suite result as JSON")
  .option("--jev", "use the Jev decision classifier (default)")
  .option("--llm", "use an LLM classifier; provider and credentials are auto-detected from the environment")
  .option("--llm-provider <provider>", "openai, anthropic, or ollama")
  .option("--llm-base-url <url>", "override the LLM API base URL or local host")
  .option("--llm-model <model>", "override the LLM model")
  .option("--llm-reasoning <level>", "override the LLM reasoning effort")
  .action(async (specFile: string | undefined, options: { init?: boolean; headed?: boolean; browser?: string; cdp?: string; executablePath?: string; userDataDir?: string; artifacts?: string; artifactRoot: string; workers?: string; json?: string; jev?: boolean; llm?: boolean; llmProvider?: string; llmBaseUrl?: string; llmModel?: string; llmReasoning?: string }) => {
    if (options.init) {
      const output = path.resolve(specFile ?? "sayspec.yaml");
      await writeFile(output, `name: My browser tests\nbaseUrl: https://example.com\nartifacts: failure\ngif: true\n\ntests:\n  - id: smoke\n    steps:\n      - do: Verify the site is available\n        expect: The Example Domain page is visible\n`);
      console.log(`Created ${output}`);
      return;
    }
    const resolvedSpec = await findSpec(specFile);
    const spec = await loadSpec(resolvedSpec);
    if (options.headed) spec.headless = false;
    if (options.browser) {
      if (!["chromium", "firefox", "webkit", "brave"].includes(options.browser)) throw new Error(`Unknown browser: ${options.browser}`);
      spec.browser = options.browser as BrowserName;
    }
    if (options.cdp) spec.cdpUrl = options.cdp;
    if (options.executablePath) spec.executablePath = options.executablePath;
    if (options.userDataDir) spec.userDataDir = options.userDataDir;
    if (options.workers !== undefined) {
      const workers = Number(options.workers);
      if (!Number.isInteger(workers) || workers < 1 || workers > 64) throw new Error("--workers must be an integer between 1 and 64");
      spec.workers = workers;
    }
    if (options.artifacts) {
      if (!["always", "failure", "off"].includes(options.artifacts)) throw new Error(`Unknown artifact mode: ${options.artifacts}`);
      spec.artifacts = options.artifacts as ArtifactMode;
    }
    if (options.jev && options.llm) throw new Error("Choose either --jev or --llm, not both");
    if (options.llmProvider && !["openai", "anthropic", "ollama"].includes(options.llmProvider)) throw new Error(`Unknown LLM provider: ${options.llmProvider}`);
    const classifier = options.llm
      ? new LlmClient({
        ...(options.llmProvider ? { provider: options.llmProvider as LlmProvider } : {}),
        ...(options.llmBaseUrl ? { baseUrl: options.llmBaseUrl } : {}),
        ...(options.llmModel ? { model: options.llmModel } : {}),
        ...(options.llmReasoning ? { reasoning: options.llmReasoning } : {}),
      })
      : new JevClient();
    console.log(`Running ${spec.name} (${spec.browser}, ${spec.headless ? "headless" : "headed"}, ${options.llm ? "LLM" : "Jev"} classifier, ${spec.workers} worker${spec.workers === 1 ? "" : "s"})`);
    const result = await new Runner(spec, { artifactRoot: options.artifactRoot, onEvent: console.log }, { classifier }).run();
    console.log(`\n${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped in ${result.durationMs}ms`);
    if (options.json) await writeFile(path.resolve(options.json), JSON.stringify(result, null, 2));
    if (result.failed > 0) process.exitCode = 1;
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
