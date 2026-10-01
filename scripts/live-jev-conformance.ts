import "dotenv/config";
import { JevClient } from "../src/jev.js";
import type { Observation, ObservedElement, Operation } from "../src/types.js";

type Case = { name: string; step: { do: string; input?: string }; expected: Operation; observation: Observation };

const element = (id: string, label: string, operations: Operation[], extra: Partial<ObservedElement> = {}): ObservedElement => ({
  id: `f0:${id}`,
  frameId: "f0",
  nodeId: id,
  role: "button",
  label,
  disabled: false,
  operations,
  signature: `BUTTON|button|${label}`,
  ...extra,
});

const observation = (text: string, elements: ObservedElement[], tabs: Observation["tabs"] = [{ index: 0, title: "Actions", url: "https://example.test/actions", active: true }]): Observation => ({
  url: tabs.find((tab) => tab.active)?.url ?? tabs[0]!.url,
  title: tabs.find((tab) => tab.active)?.title ?? tabs[0]!.title,
  text,
  elements,
  frames: new Map(),
  tabs,
  observedAt: new Date().toISOString(),
  fingerprint: "synthetic",
});

const cases: Case[] = [
  {
    name: "click",
    step: { do: "Click the Continue button to advance to checkout" },
    expected: "CLICK",
    observation: observation("Checkout setup. Continue", [element("continue", "Continue", ["CLICK"])]),
  },
  {
    name: "type",
    step: { do: "Type wireless keyboard into the Search field", input: "wireless keyboard" },
    expected: "TYPE_TEXT",
    observation: observation("Product search", [element("search", "Search products", ["CLICK", "TYPE_TEXT"], { role: "textbox", value: "" })]),
  },
  {
    name: "select",
    step: { do: "Select Canada from the Country dropdown" },
    expected: "SELECT",
    observation: observation("Shipping country United States", [element("country", "Country", ["SELECT"], { role: "combobox", value: "United States", options: [{ index: 0, label: "United States", selected: true }, { index: 1, label: "Canada", selected: false }] })]),
  },
  {
    name: "nested scroll",
    step: { do: "Scroll the Results panel down to reveal later results" },
    expected: "SCROLL_DOWN",
    observation: observation("Results 1 through 10", [element("results", "Results panel", ["SCROLL_DOWN"], { role: "region" })]),
  },
  {
    name: "keyboard",
    step: { do: "Press Enter to submit the currently focused search field" },
    expected: "PRESS_KEY",
    observation: observation("Search field is focused and contains wireless keyboard", [element("search", "Search products", ["CLICK", "TYPE_TEXT"], { role: "textbox", value: "wireless keyboard" })]),
  },
  {
    name: "back navigation",
    step: { do: "Go back to the product results page" },
    expected: "BACK",
    observation: observation("Product detail page for Wireless Keyboard", [element("cart", "Add to cart", ["CLICK"])]),
  },
  {
    name: "switch tab",
    step: { do: "Switch to the Receipt browser tab" },
    expected: "SWITCH_TAB",
    observation: observation("Order complete", [], [
      { index: 0, title: "Order", url: "https://example.test/order", active: true },
      { index: 1, title: "Receipt", url: "https://example.test/receipt", active: false },
    ]),
  },
];

const client = new JevClient();
let failures = 0;
for (const testCase of cases) {
  try {
    const decision = await client.decide(testCase.step, testCase.observation, []);
    const passed = decision.status === "ACTION" && decision.operation === testCase.expected;
    console.log(`${passed ? "PASS" : "FAIL"} ${testCase.name}: ${decision.status}${decision.operation ? `/${decision.operation}` : ""} (${decision.confidence.toFixed(3)})`);
    if (!passed) failures += 1;
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures > 0) process.exitCode = 1;
