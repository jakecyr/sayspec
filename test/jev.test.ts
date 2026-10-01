import { describe, expect, it, vi } from "vitest";
import { JevClient } from "../src/jev.js";
import type { Observation } from "../src/types.js";

const observation: Observation = {
  url: "https://example.test",
  title: "Example",
  text: "Search",
  observedAt: new Date(0).toISOString(),
  fingerprint: "fixture",
  frames: new Map(),
  tabPages: new Map(),
  tabs: [{ index: 0, title: "Example", url: "https://example.test", active: true }],
  elements: [{
    id: "f0:n1",
    frameId: "f0",
    nodeId: "n1",
    role: "textbox",
    label: "Search",
    value: "",
    disabled: false,
    operations: ["CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "HOVER", "TYPE_TEXT"],
    signature: "INPUT|textbox|Search",
  }],
};

function answer(choice: string, keys: string[]) {
  return {
    type: "choice",
    choice,
    confidence: 0.9,
    probabilities: Object.fromEntries(keys.map((key) => [key, keys.length === 1 ? 1 : key === choice ? 0.9 : 0.1 / (keys.length - 1)])),
  };
}

describe("JevClient", () => {
  it("uses only the target head matching the chosen operation", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, unknown> }> };
      const statusKeys = Object.keys(body.questions.status!.criteria);
      const operationKeys = Object.keys(body.questions.operation!.criteria);
      return new Response(JSON.stringify({ answers: {
        status: answer("ACTION", statusKeys),
        operation: answer("TYPE_TEXT", operationKeys),
        type_text_target: answer("f0:n1", ["f0:n1"]),
        click_target: { nonsense: true },
      } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "test", fetch: fetcher, minimumConfidence: 0 });
    const decision = await client.decide({ do: "Search for cats" }, observation, []);
    expect(decision).toMatchObject({ status: "ACTION", operation: "TYPE_TEXT", elementId: "f0:n1" });
  });

  it("rejects a choice that is not the most probable", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ answers: {
      status: { type: "choice", choice: "COMPLETE", confidence: 0.8, probabilities: { ACTION: 0.8, COMPLETE: 0.1, BLOCKED: 0.1 } },
    } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const client = new JevClient({ apiKey: "test", fetch: fetcher });
    await expect(client.decide({ do: "Search" }, observation, [])).rejects.toThrow(/inconsistent/);
  });

  it.each([
    { operation: "SELECT", target: "f0:select::1", expected: { elementId: "f0:select", optionIndex: 1 } },
    { operation: "SCROLL_DOWN", target: "f0:panel", expected: { elementId: "f0:panel" } },
    { operation: "CHECK", target: "f0:checkbox", expected: { elementId: "f0:checkbox" } },
    { operation: "HOVER", target: "f0:n1", expected: { elementId: "f0:n1" } },
    { operation: "DOUBLE_CLICK", target: "f0:n1", expected: { elementId: "f0:n1" } },
    { operation: "RIGHT_CLICK", target: "f0:n1", expected: { elementId: "f0:n1" } },
    { operation: "UPLOAD_FILE", target: "f0:upload", expected: { elementId: "f0:upload" }, step: { do: "Upload fixture", files: ["fixture.txt"] } },
    { operation: "DRAG_DROP", target: "f0:drag", dropTarget: "f0:drop", expected: { elementId: "f0:drag", dropElementId: "f0:drop" } },
    { operation: "PRESS_KEY", target: "Enter", expected: { key: "Enter" } },
    { operation: "SWITCH_TAB", target: "1", expected: { tabIndex: 1 } },
    { operation: "CLOSE_TAB", target: undefined, expected: {} },
    { operation: "BACK", target: undefined, expected: {} },
    { operation: "FORWARD", target: undefined, expected: {} },
    { operation: "RELOAD", target: undefined, expected: {} },
  ])("validates and decodes $operation decisions", async ({ operation, target, dropTarget, expected, step }) => {
    const richObservation: Observation = {
      ...observation,
      tabs: [
        { index: 0, title: "Actions", url: "https://example.test/actions", active: true },
        { index: 1, title: "Receipt", url: "https://example.test/receipt", active: false },
      ],
      elements: [
        ...observation.elements,
        {
          id: "f0:select", frameId: "f0", nodeId: "select", role: "combobox", label: "Country", value: "US", disabled: false,
          operations: ["SELECT"], signature: "SELECT|combobox|Country",
          options: [{ index: 0, label: "US", selected: true }, { index: 1, label: "Canada", selected: false }],
        },
        { id: "f0:panel", frameId: "f0", nodeId: "panel", role: "region", label: "Results", disabled: false, operations: ["SCROLL_DOWN"], signature: "DIV|region|Results" },
        { id: "f0:checkbox", frameId: "f0", nodeId: "checkbox", role: "checkbox", label: "Updates", checked: false, disabled: false, operations: ["CHECK", "HOVER"], signature: "INPUT|checkbox|Updates" },
        { id: "f0:upload", frameId: "f0", nodeId: "upload", role: "input", label: "Fixture", disabled: false, operations: ["UPLOAD_FILE"], signature: "INPUT|input|Fixture" },
        { id: "f0:drag", frameId: "f0", nodeId: "drag", role: "button", label: "Card", disabled: false, operations: ["DRAG_DROP"], signature: "BUTTON|button|Card" },
        { id: "f0:drop", frameId: "f0", nodeId: "drop", role: "region", label: "Drop here", disabled: false, operations: ["CLICK"], signature: "DIV|region|Drop here" },
      ],
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, unknown> }> };
      const answers: Record<string, unknown> = {
        status: answer("ACTION", Object.keys(body.questions.status!.criteria)),
        operation: answer(operation, Object.keys(body.questions.operation!.criteria)),
      };
      if (target !== undefined) {
        const head = `${operation.toLowerCase()}_target`;
        answers[head] = answer(target, Object.keys(body.questions[head]!.criteria));
      }
      if (dropTarget !== undefined) answers.drop_target = answer(dropTarget, Object.keys(body.questions.drop_target!.criteria));
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new JevClient({ apiKey: "test", fetch: fetcher, minimumConfidence: 0 });
    const decision = await client.decide(step ?? { do: `Perform ${operation}` }, richObservation, []);
    expect(decision).toMatchObject({ status: "ACTION", operation, ...expected });
  });
});
