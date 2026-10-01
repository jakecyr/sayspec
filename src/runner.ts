import path from "node:path";
import { ArtifactRecorder } from "./artifacts.js";
import { BrowserSession, StaleObservationError } from "./browser.js";
import { JevClient } from "./jev.js";
import { orderedTests } from "./spec.js";
import { TextModel } from "./text-model.js";
import type { AssertionSpec, HistoryEntry, SuiteResult, SuiteSpec, TestResult, TestSpec } from "./types.js";

export interface Classifier {
  decide(step: TestSpec["steps"][number], observation: Awaited<ReturnType<BrowserSession["observe"]>>, history: HistoryEntry[]): ReturnType<JevClient["decide"]>;
  assert(expectation: string, observation: Awaited<ReturnType<BrowserSession["observe"]>>, context: string): ReturnType<JevClient["assert"]>;
}

export interface RunnerOptions {
  artifactRoot?: string;
  onEvent?: (message: string) => void;
}

export class Runner {
  private readonly classifier: Classifier;
  private readonly textModel: TextModel;
  private readonly artifactRoot: string;
  private readonly log: (message: string) => void;

  constructor(private readonly spec: SuiteSpec, options: RunnerOptions = {}, clients?: { classifier?: Classifier; jev?: JevClient; textModel?: TextModel }) {
    this.classifier = clients?.classifier ?? clients?.jev ?? new JevClient();
    this.textModel = clients?.textModel ?? new TextModel();
    this.artifactRoot = options.artifactRoot ?? path.resolve("artifacts");
    this.log = options.onEvent ?? (() => undefined);
  }

  private async checkAssertions(assertions: AssertionSpec[], browser: BrowserSession, test: TestSpec, timing: "end" | "throughout"): Promise<void> {
    for (const assertion of assertions.filter((candidate) => candidate.timing === timing)) {
      const observation = await browser.observe();
      const result = await this.classifier.assert(assertion.expect, observation, `Test ${test.id}: ${test.goal ?? test.name ?? test.id}`);
      if (!result.passed) throw new Error(`${timing} assertion failed (${result.confidence.toFixed(3)}): ${assertion.expect}`);
    }
  }

  private async runStep(
    step: TestSpec["steps"][number],
    test: TestSpec,
    browser: BrowserSession,
    history: HistoryEntry[],
    recorder: ArtifactRecorder | undefined,
    cleanup: boolean,
  ): Promise<void> {
    const limit = step.maxActions ?? this.spec.maxActionsPerStep;
    let repeatedDecision = "";
    let repeatedCount = 0;
    for (let attempt = 0; attempt < limit; attempt++) {
      const observation = await browser.observe();
      await recorder?.capture(browser);
      const decision = await this.classifier.decide(step, observation, history);
      const entry: HistoryEntry = {
        at: new Date().toISOString(),
        step: step.do,
        status: decision.status,
        confidence: decision.confidence,
        latencyMs: decision.latencyMs,
      };
      if (decision.operation !== undefined) entry.operation = decision.operation;
      const selected = observation.elements.find((element) => element.id === decision.elementId);
      if (selected) entry.target = selected.label;
      const decisionKey = `${observation.fingerprint}:${decision.status}:${decision.operation ?? ""}:${decision.elementId ?? ""}:${decision.optionIndex ?? ""}:${decision.key ?? ""}`;
      repeatedCount = decisionKey === repeatedDecision ? repeatedCount + 1 : 1;
      repeatedDecision = decisionKey;
      if (repeatedCount >= 3) throw new Error(`Jev repeated the same no-progress decision three times: ${decision.operation ?? decision.status}`);
      history.push(entry);
      this.log(`    ${cleanup ? "cleanup " : ""}${decision.status}${decision.operation ? ` ${decision.operation}` : ""}${selected ? ` → ${selected.label}` : ""}`);

      if (decision.status === "COMPLETE" || decision.status === "SKIP") return;
      if (decision.status === "BLOCKED") throw new Error(`Jev reported the step is blocked: ${step.do}`);
      if (!decision.operation) throw new Error("Jev chose ACTION without an operation");
      let text: string | undefined;
      if (decision.operation === "TYPE_TEXT") {
        if (!selected) throw new Error("Jev chose TYPE_TEXT without a field");
        const envValue = step.inputEnv ? process.env[step.inputEnv] : undefined;
        if (step.inputEnv && envValue === undefined) throw new Error(`Environment variable ${step.inputEnv} is not set`);
        text = step.input ?? envValue ?? await this.textModel.valueFor(step, selected, observation, history);
        entry.text = step.sensitive || step.inputEnv || selected.value === "[redacted]" ? "[redacted]" : text;
      }
      if (decision.operation === "UPLOAD_FILE") {
        if (!step.files?.length) throw new Error("Jev selected UPLOAD_FILE but the step does not authorize files");
        text = JSON.stringify(step.files.map((file) => path.resolve(this.spec.rootDir ?? process.cwd(), file)));
      }
      if (decision.operation === "DRAG_DROP") {
        if (!decision.dropElementId) throw new Error("Jev selected DRAG_DROP without a drop target");
        text = decision.dropElementId;
      }
      try {
        await browser.execute(observation, decision.operation, decision.elementId, decision.optionIndex, text, decision.key, decision.tabIndex);
      } catch (caught) {
        if (caught instanceof StaleObservationError) {
          history.push({ at: new Date().toISOString(), step: step.do, status: "STALE_RETRY" });
          continue;
        }
        throw caught;
      }
      if (!cleanup) await this.checkAssertions(test.assertions, browser, test, "throughout");
    }
    throw new Error(`Step exceeded ${limit} browser actions: ${step.do}`);
  }

  private async runTest(test: TestSpec, browser: BrowserSession, runId: string): Promise<TestResult> {
    const started = performance.now();
    const history: HistoryEntry[] = [];
    const recorder = this.spec.artifacts === "off" ? undefined : new ArtifactRecorder(this.artifactRoot, runId, test.id);
    await recorder?.start();
    let error: Error | undefined;
    try {
      const url = test.url ?? this.spec.baseUrl;
      await browser.resetTabs();
      if (url) await browser.goto(new URL(url, this.spec.baseUrl).toString());
      await this.checkAssertions(test.assertions, browser, test, "throughout");
      for (const step of test.steps) await this.runStep(step, test, browser, history, recorder, false);
      await this.checkAssertions(test.assertions, browser, test, "end");
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
      try { await recorder?.capture(browser); } catch { /* retain the original failure */ }
    } finally {
      for (const step of test.cleanup) {
        try {
          await this.runStep(step, test, browser, history, recorder, true);
        } catch (caught) {
          const cleanupError = caught instanceof Error ? caught : new Error(String(caught));
          error = error ? new Error(`${error.message}; cleanup also failed: ${cleanupError.message}`) : cleanupError;
        }
      }
    }

    await recorder?.trace(history, error?.message);
    if (recorder && this.spec.gif && (this.spec.artifacts === "always" || error)) {
      try { await recorder.gif(); } catch (caught) {
        this.log(`    warning: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    if (recorder && this.spec.artifacts === "failure" && !error) await recorder.discard();
    const result: TestResult = {
      id: test.id,
      status: error ? "failed" : "passed",
      durationMs: Math.round(performance.now() - started),
    };
    if (error) result.error = error.message;
    if (recorder && (this.spec.artifacts === "always" || error)) result.artifactDir = recorder.directory;
    return result;
  }

  async run(): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const runId = `${startedAt.replace(/[:.]/g, "-")}-${this.spec.name}`;
    const results: TestResult[] = [];
    const byId = new Map<string, TestResult>();
    const browserOptions: { cdpUrl?: string; executablePath?: string; userDataDir?: string } = {};
    if (this.spec.cdpUrl !== undefined) browserOptions.cdpUrl = this.spec.cdpUrl;
    if (this.spec.executablePath !== undefined) browserOptions.executablePath = this.spec.executablePath;
    if (this.spec.userDataDir !== undefined) browserOptions.userDataDir = this.spec.userDataDir;
    const browser = new BrowserSession(this.spec.browser, this.spec.headless, this.spec.timeoutMs, browserOptions);
    await browser.start();
    try {
      for (const test of orderedTests(this.spec)) {
        const failedDependency = test.dependsOn.find((dependency) => byId.get(dependency)?.status !== "passed");
        if (failedDependency) {
          const result: TestResult = { id: test.id, status: "skipped", durationMs: 0, error: `Dependency ${failedDependency} did not pass` };
          results.push(result);
          byId.set(test.id, result);
          this.log(`  - ${test.id}: skipped (${result.error})`);
          continue;
        }
        this.log(`  - ${test.id}`);
        const result = await this.runTest(test, browser, runId);
        results.push(result);
        byId.set(test.id, result);
        this.log(`    ${result.status} in ${result.durationMs}ms${result.error ? `: ${result.error}` : ""}`);
      }
    } finally {
      await browser.close();
    }
    return {
      name: this.spec.name,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      tests: results,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      skipped: results.filter((result) => result.status === "skipped").length,
    };
  }
}
