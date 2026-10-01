import { access, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AssertionSpec, StepSpec, SuiteSpec, TestSpec } from "./types.js";

const stepInput = z.union([
  z.string().min(1),
  z.object({
    do: z.string().min(1),
    when: z.string().min(1).optional(),
    expect: z.string().min(1).optional(),
    input: z.string().min(1).max(2_000).optional(),
    inputEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    sensitive: z.boolean().optional(),
    files: z.array(z.string().min(1)).min(1).optional(),
    maxActions: z.number().int().positive().max(200).optional(),
  }),
]);

const assertionInput = z.union([
  z.string().min(1),
  z.object({
    expect: z.string().min(1),
    timing: z.enum(["end", "throughout"]).default("end"),
  }),
]);

const suiteInput = z.object({
  name: z.string().min(1).default("SaySpec browser suite"),
  baseUrl: z.string().url().optional(),
  browser: z.enum(["chromium", "firefox", "webkit", "brave"]).default("chromium"),
  cdpUrl: z.string().url().optional(),
  executablePath: z.string().min(1).optional(),
  userDataDir: z.string().min(1).optional(),
  headless: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  maxActionsPerStep: z.number().int().positive().max(200).default(20),
  artifacts: z.enum(["always", "failure", "off"]).default("failure"),
  gif: z.boolean().default(true),
  workers: z.number().int().positive().max(64).default(1),
  tests: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    dependsOn: z.array(z.string()).default([]),
    stateFrom: z.string().optional(),
    steps: z.array(stepInput).min(1),
    cleanup: z.array(stepInput).default([]),
    assertions: z.array(assertionInput).default([]),
  })).min(1),
});

function normalizeStep(input: z.infer<typeof stepInput>): StepSpec {
  if (typeof input === "string") return { do: input };
  const step: StepSpec = { do: input.do };
  if (input.when !== undefined) step.when = input.when;
  if (input.expect !== undefined) step.expect = input.expect;
  if (input.input !== undefined) step.input = input.input;
  if (input.inputEnv !== undefined) step.inputEnv = input.inputEnv;
  if (input.sensitive !== undefined) step.sensitive = input.sensitive;
  if (step.input !== undefined && step.inputEnv !== undefined) throw new Error(`Step cannot define both input and inputEnv: ${step.do}`);
  if (input.files !== undefined) step.files = input.files;
  if (input.maxActions !== undefined) step.maxActions = input.maxActions;
  return step;
}

function normalizeAssertion(input: z.infer<typeof assertionInput>): AssertionSpec {
  return typeof input === "string" ? { expect: input, timing: "end" } : input;
}

function validateGraph(tests: TestSpec[]): void {
  const ids = new Set<string>();
  for (const test of tests) {
    if (ids.has(test.id)) throw new Error(`Duplicate test id: ${test.id}`);
    ids.add(test.id);
  }
  for (const test of tests) {
    for (const dep of test.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Test ${test.id} depends on unknown test ${dep}`);
      if (dep === test.id) throw new Error(`Test ${test.id} cannot depend on itself`);
    }
    if (test.stateFrom !== undefined && !test.dependsOn.includes(test.stateFrom)) {
      throw new Error(`Test ${test.id} stateFrom must name one of its direct dependencies`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tests.map((test) => [test.id, test]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const test of tests) visit(test.id);
}

export function parseSpec(value: unknown): SuiteSpec {
  const input = suiteInput.parse(value);
  const tests: TestSpec[] = input.tests.map((test) => {
    const normalized: TestSpec = {
      id: test.id,
      dependsOn: test.dependsOn,
      steps: test.steps.map(normalizeStep),
      cleanup: test.cleanup.map(normalizeStep),
      assertions: test.assertions.map(normalizeAssertion),
    };
    if (test.name !== undefined) normalized.name = test.name;
    if (test.goal !== undefined) normalized.goal = test.goal;
    if (test.url !== undefined) normalized.url = test.url;
    if (test.stateFrom !== undefined) normalized.stateFrom = test.stateFrom;
    return normalized;
  });
  validateGraph(tests);
  const suite: SuiteSpec = {
    name: input.name,
    browser: input.browser,
    headless: input.headless,
    timeoutMs: input.timeoutMs,
    maxActionsPerStep: input.maxActionsPerStep,
    artifacts: input.artifacts,
    gif: input.gif,
    workers: input.workers,
    tests,
  };
  if (input.baseUrl !== undefined) suite.baseUrl = input.baseUrl;
  if (input.cdpUrl !== undefined) suite.cdpUrl = input.cdpUrl;
  if (input.executablePath !== undefined) suite.executablePath = input.executablePath;
  if (input.userDataDir !== undefined) suite.userDataDir = input.userDataDir;
  return suite;
}

export async function loadSpec(file: string): Promise<SuiteSpec> {
  const source = await readFile(file, "utf8");
  const extension = path.extname(file).toLowerCase();
  const value: unknown = extension === ".json" ? JSON.parse(source) : YAML.parse(source);
  const spec = parseSpec(value);
  spec.rootDir = path.dirname(path.resolve(file));
  return spec;
}

const conventionalNames = ["sayspec.yaml", "sayspec.yml", "sayspec.json", ".sayspec.yaml", ".sayspec.yml"];

export async function findSpec(input?: string, start = process.cwd()): Promise<string> {
  if (input) {
    const resolved = path.resolve(start, input);
    try {
      const stat = await import("node:fs/promises").then(({ stat }) => stat(resolved));
      if (stat.isFile()) return resolved;
      if (stat.isDirectory()) {
        for (const name of conventionalNames) {
          const candidate = path.join(resolved, name);
          try { await access(candidate); return candidate; } catch { /* keep looking */ }
        }
      }
    } catch { /* provide the focused error below */ }
    throw new Error(`No SaySpec file found at ${resolved}`);
  }
  let directory = path.resolve(start);
  for (;;) {
    for (const name of conventionalNames) {
      const candidate = path.join(directory, name);
      try { await access(candidate); return candidate; } catch { /* keep looking */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`No SaySpec file found. Expected one of: ${conventionalNames.join(", ")}`);
}

export function orderedTests(spec: SuiteSpec): TestSpec[] {
  const byId = new Map(spec.tests.map((test) => [test.id, test]));
  const result: TestSpec[] = [];
  const seen = new Set<string>();
  const visit = (test: TestSpec): void => {
    if (seen.has(test.id)) return;
    for (const dependency of test.dependsOn) visit(byId.get(dependency)!);
    seen.add(test.id);
    result.push(test);
  };
  for (const test of spec.tests) visit(test);
  return result;
}
