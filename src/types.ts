import type { Frame, Page } from "playwright";

export type BrowserName = "chromium" | "firefox" | "webkit" | "brave";
export type ArtifactMode = "always" | "failure" | "off";

export interface AssertionSpec {
  expect: string;
  timing: "end" | "throughout";
}

export interface StepSpec {
  do: string;
  when?: string;
  expect?: string;
  /** Optional exact value for a typing step; avoids a generative text-model call. */
  input?: string;
  /** Read an exact typing value from this environment variable at execution time. */
  inputEnv?: string;
  sensitive?: boolean;
  /** User-authored local paths made available only if Jev selects UPLOAD_FILE. */
  files?: string[];
  maxActions?: number;
}

export interface TestSpec {
  id: string;
  name?: string;
  goal?: string;
  url?: string;
  dependsOn: string[];
  steps: StepSpec[];
  cleanup: StepSpec[];
  assertions: AssertionSpec[];
}

export interface SuiteSpec {
  name: string;
  /** Directory containing the loaded spec; used to resolve user-authored file paths. */
  rootDir?: string;
  baseUrl?: string;
  browser: BrowserName;
  cdpUrl?: string;
  executablePath?: string;
  userDataDir?: string;
  headless: boolean;
  timeoutMs: number;
  maxActionsPerStep: number;
  artifacts: ArtifactMode;
  gif: boolean;
  tests: TestSpec[];
}

export type Operation =
  | "CLICK"
  | "DOUBLE_CLICK"
  | "RIGHT_CLICK"
  | "HOVER"
  | "TYPE_TEXT"
  | "SELECT"
  | "CHECK"
  | "UNCHECK"
  | "UPLOAD_FILE"
  | "DRAG_DROP"
  | "PRESS_KEY"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "SWITCH_TAB"
  | "WAIT"
  | "BACK"
  | "FORWARD"
  | "RELOAD"
  | "CLOSE_TAB";

export interface ObservedElement {
  id: string;
  frameId: string;
  nodeId: string;
  role: string;
  label: string;
  value?: string;
  checked?: boolean;
  focused?: boolean;
  disabled: boolean;
  operations: Operation[];
  options?: Array<{ index: number; label: string; selected: boolean }>;
  signature: string;
}

export interface Observation {
  url: string;
  title: string;
  text: string;
  elements: ObservedElement[];
  frames: Map<string, Frame>;
  tabPages: Map<number, Page>;
  tabs: Array<{ index: number; title: string; url: string; active: boolean }>;
  observedAt: string;
  fingerprint: string;
}

export interface Decision {
  status: "ACTION" | "COMPLETE" | "SKIP" | "BLOCKED";
  operation?: Operation;
  elementId?: string;
  optionIndex?: number;
  key?: AllowedKey;
  tabIndex?: number;
  dropElementId?: string;
  confidence: number;
  probabilities: Record<string, number>;
  latencyMs: number;
  rawAnswers: Record<string, unknown>;
}

export type AllowedKey =
  | "Enter"
  | "Escape"
  | "Tab"
  | "Shift+Tab"
  | "Space"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "PageUp"
  | "PageDown"
  | "Home"
  | "End"
  | "ControlOrMeta+A";

export interface HistoryEntry {
  at: string;
  step: string;
  status: string;
  operation?: Operation;
  target?: string;
  text?: string;
  confidence?: number;
  latencyMs?: number;
}

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
  id: string;
  status: TestStatus;
  durationMs: number;
  error?: string;
  artifactDir?: string;
}

export interface SuiteResult {
  name: string;
  startedAt: string;
  durationMs: number;
  tests: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
}
