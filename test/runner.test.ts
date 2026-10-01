import { describe, expect, it } from "vitest";
import { Runner, type Classifier } from "../src/runner.js";
import { parseSpec } from "../src/spec.js";
import type { BrowserSession, BrowserStorageState } from "../src/browser.js";
import type { Decision, Observation } from "../src/types.js";

const emptyObservation: Observation = {
  url: "about:blank",
  title: "Test",
  text: "",
  elements: [],
  frames: new Map(),
  tabPages: new Map(),
  tabs: [],
  observedAt: new Date(0).toISOString(),
  fingerprint: "test",
};

const complete = (): Decision => ({
  status: "COMPLETE",
  confidence: 1,
  probabilities: { COMPLETE: 1 },
  latencyMs: 0,
  rawAnswers: {},
});

class FakeBrowser {
  private url = "about:blank";

  constructor(
    readonly initialState: BrowserStorageState | undefined,
    private readonly outputState: BrowserStorageState,
  ) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async resetTabs(): Promise<void> {}
  async goto(url: string): Promise<void> { this.url = url; }
  async observe(): Promise<Observation> { return { ...emptyObservation, url: this.url }; }
  async storageState(): Promise<BrowserStorageState> { return this.outputState; }
  currentPage(): { url(): string } { return { url: () => this.url }; }
}

describe("Runner dependency workers", () => {
  it("runs login once, restores its state into isolated dependents, and runs them concurrently", async () => {
    const loginState: BrowserStorageState = {
      cookies: [{ name: "session", value: "token", domain: "example.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
      origins: [],
    };
    const receivedStates: Array<BrowserStorageState | undefined> = [];
    let active = 0;
    let maximumActive = 0;
    const classifier: Classifier = {
      async decide(step) {
        if (step.do !== "Sign in") {
          active++;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 25));
          active--;
        }
        return complete();
      },
      async assert() { return { passed: true, confidence: 1, latencyMs: 0, rawAnswer: {} }; },
    };
    const spec = parseSpec({
      name: "parallel auth",
      baseUrl: "https://example.test",
      workers: 2,
      artifacts: "off",
      tests: [
        { id: "login", steps: ["Sign in"] },
        { id: "account", dependsOn: ["login"], steps: ["Check account"] },
        { id: "orders", dependsOn: ["login"], steps: ["Check orders"] },
      ],
    });
    const result = await new Runner(spec, {
      browserFactory: (state) => {
        receivedStates.push(state);
        return new FakeBrowser(state, loginState) as unknown as BrowserSession;
      },
    }, { classifier }).run();

    expect(result.tests.map((test) => [test.id, test.status])).toEqual([
      ["login", "passed"], ["account", "passed"], ["orders", "passed"],
    ]);
    expect(receivedStates).toHaveLength(3);
    expect(receivedStates[0]).toBeUndefined();
    expect(receivedStates[1]).toEqual(loginState);
    expect(receivedStates[2]).toEqual(loginState);
    expect(maximumActive).toBe(2);
  });

  it("does not launch a dependent when its prerequisite fails", async () => {
    let browserCount = 0;
    const classifier: Classifier = {
      async decide() { return { ...complete(), status: "BLOCKED" }; },
      async assert() { return { passed: true, confidence: 1, latencyMs: 0, rawAnswer: {} }; },
    };
    const spec = parseSpec({
      name: "failed auth",
      workers: 2,
      artifacts: "off",
      tests: [
        { id: "login", steps: ["Sign in"] },
        { id: "account", dependsOn: ["login"], steps: ["Check account"] },
      ],
    });
    const result = await new Runner(spec, {
      browserFactory: (state) => {
        browserCount++;
        return new FakeBrowser(state, { cookies: [], origins: [] }) as unknown as BrowserSession;
      },
    }, { classifier }).run();

    expect(result.tests[0]?.status).toBe("failed");
    expect(result.tests[1]?.status).toBe("skipped");
    expect(browserCount).toBe(1);
  });

  it("requires stateFrom when isolated state has multiple possible parents", async () => {
    const classifier: Classifier = {
      async decide() { return complete(); },
      async assert() { return { passed: true, confidence: 1 }; },
    };
    const spec = parseSpec({
      name: "ambiguous state",
      artifacts: "off",
      tests: [
        { id: "login", steps: ["Sign in"] },
        { id: "seed", steps: ["Seed data"] },
        { id: "combined", dependsOn: ["login", "seed"], steps: ["Check"] },
      ],
    });
    await expect(new Runner(spec, {}, { classifier }).run()).rejects.toThrow(/stateFrom/);
  });
});
