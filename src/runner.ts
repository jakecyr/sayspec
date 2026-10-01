import path from "node:path";
import { ArtifactRecorder } from "./artifacts.js";
import { BrowserSession, StaleObservationError, type BrowserSessionOptions, type BrowserStorageState } from "./browser.js";
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
  /** Test hook for supplying a BrowserSession-compatible instance. */
  browserFactory?: (storageState?: BrowserStorageState) => BrowserSession;
}

interface TestExecution {
  result: TestResult;
  storageState?: BrowserStorageState;
  url?: string;
}

export class Runner {
  private readonly classifier: Classifier;
  private readonly textModel: TextModel;
  private readonly artifactRoot: string;
  private readonly log: (message: string) => void;
  private readonly browserFactory: ((storageState?: BrowserStorageState) => BrowserSession) | undefined;

  constructor(private readonly spec: SuiteSpec, options: RunnerOptions = {}, clients?: { classifier?: Classifier; jev?: JevClient; textModel?: TextModel }) {
    this.classifier = clients?.classifier ?? clients?.jev ?? new JevClient();
    this.textModel = clients?.textModel ?? new TextModel();
    this.artifactRoot = options.artifactRoot ?? path.resolve("artifacts");
    this.log = options.onEvent ?? (() => undefined);
    this.browserFactory = options.browserFactory;
  }

  private createBrowser(storageState?: BrowserStorageState): BrowserSession {
    if (this.browserFactory) return this.browserFactory(storageState);
    const browserOptions: BrowserSessionOptions = {};
    if (this.spec.cdpUrl !== undefined) browserOptions.cdpUrl = this.spec.cdpUrl;
    if (this.spec.executablePath !== undefined) browserOptions.executablePath = this.spec.executablePath;
    if (this.spec.userDataDir !== undefined) browserOptions.userDataDir = this.spec.userDataDir;
    if (storageState !== undefined) browserOptions.storageState = storageState;
    return new BrowserSession(this.spec.browser, this.spec.headless, this.spec.timeoutMs, browserOptions);
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

  private async runTest(test: TestSpec, browser: BrowserSession, runId: string, inheritedUrl?: string): Promise<TestResult> {
    const started = performance.now();
    const history: HistoryEntry[] = [];
    const recorder = this.spec.artifacts === "off" ? undefined : new ArtifactRecorder(this.artifactRoot, runId, test.id);
    await recorder?.start();
    let error: Error | undefined;
    try {
      const url = test.url ?? this.spec.baseUrl ?? inheritedUrl;
      await browser.resetTabs();
      if (url) await browser.goto(new URL(url, this.spec.baseUrl ?? inheritedUrl).toString());
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

  private async runIsolatedTest(test: TestSpec, runId: string, inherited?: Omit<TestExecution, "result">): Promise<TestExecution> {
    const browser = this.createBrowser(inherited?.storageState);
    try {
      await browser.start();
      const result = await this.runTest(test, browser, runId, inherited?.url);
      if (result.status !== "passed") return { result };
      return {
        result,
        storageState: await browser.storageState(),
        url: browser.currentPage().url(),
      };
    } catch (caught) {
      return {
        result: {
          id: test.id,
          status: "failed",
          durationMs: 0,
          error: caught instanceof Error ? caught.message : String(caught),
        },
      };
    } finally {
      await browser.close();
    }
  }

  private inheritedExecution(test: TestSpec, executions: Map<string, TestExecution>): Omit<TestExecution, "result"> | undefined {
    if (test.dependsOn.length === 0) return undefined;
    const stateSource = test.stateFrom ?? test.dependsOn[0]!;
    const execution = executions.get(stateSource);
    if (!execution) throw new Error(`Browser state dependency ${stateSource} has not completed for ${test.id}`);
    const inherited: Omit<TestExecution, "result"> = {};
    if (execution.storageState !== undefined) inherited.storageState = execution.storageState;
    if (execution.url !== undefined) inherited.url = execution.url;
    return inherited;
  }

  private async runShared(runId: string): Promise<TestResult[]> {
    if (this.spec.workers !== 1) throw new Error("CDP and userDataDir suites require workers: 1 because a persistent browser context cannot be safely shared by parallel tests");
    const results: TestResult[] = [];
    const byId = new Map<string, TestResult>();
    const browser = this.createBrowser();
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
    return results;
  }

  private async runIsolated(runId: string): Promise<TestResult[]> {
    const ordered = orderedTests(this.spec);
    const ambiguous = ordered.find((test) => test.dependsOn.length > 1 && test.stateFrom === undefined);
    if (ambiguous) throw new Error(`Test ${ambiguous.id} has multiple dependencies; set stateFrom to choose which dependency supplies browser state`);

    const pending = new Map(ordered.map((test) => [test.id, test]));
    const executions = new Map<string, TestExecution>();
    const running = new Map<string, Promise<{ id: string; execution: TestExecution }>>();

    while (pending.size > 0 || running.size > 0) {
      let madeProgress = false;
      for (const [id, test] of pending) {
        if (running.size >= this.spec.workers) break;
        if (!test.dependsOn.every((dependency) => executions.has(dependency))) continue;
        pending.delete(id);
        madeProgress = true;
        const failedDependency = test.dependsOn.find((dependency) => executions.get(dependency)?.result.status !== "passed");
        if (failedDependency) {
          const result: TestResult = { id, status: "skipped", durationMs: 0, error: `Dependency ${failedDependency} did not pass` };
          executions.set(id, { result });
          this.log(`  - ${id}: skipped (${result.error})`);
          continue;
        }

        this.log(`  - ${id}`);
        const inherited = this.inheritedExecution(test, executions);
        const promise = this.runIsolatedTest(test, runId, inherited).then((execution) => ({ id, execution }));
        running.set(id, promise);
      }

      if (running.size > 0) {
        const completed = await Promise.race(running.values());
        running.delete(completed.id);
        executions.set(completed.id, completed.execution);
        const result = completed.execution.result;
        this.log(`    ${result.id}: ${result.status} in ${result.durationMs}ms${result.error ? `: ${result.error}` : ""}`);
        continue;
      }
      if (pending.size > 0 && !madeProgress) throw new Error("Dependency scheduler could not make progress");
    }

    return ordered.map((test) => executions.get(test.id)!.result);
  }

  async run(): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const runId = `${startedAt.replace(/[:.]/g, "-")}-${this.spec.name}`;
    const results = this.spec.cdpUrl || this.spec.userDataDir
      ? await this.runShared(runId)
      : await this.runIsolated(runId);
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
