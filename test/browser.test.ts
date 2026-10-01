import { describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/browser.js";
import type { Observation, ObservedElement, Operation } from "../src/types.js";

function harness(operation: Operation) {
  const methods = {
    click: vi.fn(), dblclick: vi.fn(), hover: vi.fn(), check: vi.fn(), uncheck: vi.fn(), fill: vi.fn(),
    selectOption: vi.fn(), setInputFiles: vi.fn(), dragTo: vi.fn(),
    count: vi.fn(async () => 1), isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => true),
    evaluate: vi.fn(async () => "BUTTON|button|Target"),
  };
  const drop = { ...methods, evaluate: vi.fn(async () => "DIV|region|Drop") };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) => selector.includes("drop") ? drop : methods,
    evaluate: vi.fn(),
  };
  const page = {
    url: () => "https://example.test",
    waitForTimeout: vi.fn(),
    keyboard: { press: vi.fn() },
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), close: vi.fn(), bringToFront: vi.fn(),
    isClosed: () => false,
  };
  const source: ObservedElement = {
    id: "f0:source", frameId: "f0", nodeId: "source", role: "button", label: "Target",
    disabled: false, operations: [operation], signature: "BUTTON|button|Target",
  };
  const dropElement: ObservedElement = {
    id: "f0:drop", frameId: "f0", nodeId: "drop", role: "region", label: "Drop",
    disabled: false, operations: ["CLICK"], signature: "DIV|region|Drop",
  };
  const observation: Observation = {
    url: "https://example.test", title: "Test", text: "", elements: [source, dropElement],
    frames: new Map([["f0", frame as never]]), tabPages: new Map([[0, page as never]]),
    tabs: [{ index: 0, title: "Test", url: "https://example.test", active: true }],
    observedAt: new Date(0).toISOString(), fingerprint: "x",
  };
  const session = new BrowserSession("chromium", true, 1_000);
  Object.assign(session, { page, context: { pages: () => [page] } });
  return { session, observation, methods, drop, page };
}

describe("BrowserSession action dispatch", () => {
  it.each([
    ["CLICK", "click"], ["DOUBLE_CLICK", "dblclick"], ["HOVER", "hover"],
    ["CHECK", "check"], ["UNCHECK", "uncheck"],
  ] as const)("executes %s on only the observed target", async (operation, method) => {
    const h = harness(operation);
    await h.session.execute(h.observation, operation, "f0:source");
    expect(h.methods[method]).toHaveBeenCalledOnce();
  });

  it("uses a right mouse button for RIGHT_CLICK", async () => {
    const h = harness("RIGHT_CLICK");
    await h.session.execute(h.observation, "RIGHT_CLICK", "f0:source");
    expect(h.methods.click).toHaveBeenCalledWith({ button: "right" });
  });

  it("dispatches text, select, upload, and drag data without model-created selectors", async () => {
    const typing = harness("TYPE_TEXT");
    await typing.session.execute(typing.observation, "TYPE_TEXT", "f0:source", undefined, "hello");
    expect(typing.methods.fill).toHaveBeenCalledWith("hello");

    const selecting = harness("SELECT");
    await selecting.session.execute(selecting.observation, "SELECT", "f0:source", 2);
    expect(selecting.methods.selectOption).toHaveBeenCalledWith({ index: 2 });

    const upload = harness("UPLOAD_FILE");
    await upload.session.execute(upload.observation, "UPLOAD_FILE", "f0:source", undefined, JSON.stringify(["/tmp/a.txt"]));
    expect(upload.methods.setInputFiles).toHaveBeenCalledWith(["/tmp/a.txt"]);

    const drag = harness("DRAG_DROP");
    await drag.session.execute(drag.observation, "DRAG_DROP", "f0:source", undefined, "f0:drop");
    expect(drag.methods.dragTo).toHaveBeenCalledWith(drag.drop);
  });

  it("dispatches allowlisted keyboard and history operations", async () => {
    const h = harness("PRESS_KEY");
    await h.session.execute(h.observation, "PRESS_KEY", undefined, undefined, undefined, "Enter");
    await h.session.execute(h.observation, "BACK");
    await h.session.execute(h.observation, "FORWARD");
    await h.session.execute(h.observation, "RELOAD");
    expect(h.page.keyboard.press).toHaveBeenCalledWith("Enter");
    expect(h.page.goBack).toHaveBeenCalledOnce();
    expect(h.page.goForward).toHaveBeenCalledOnce();
    expect(h.page.reload).toHaveBeenCalledOnce();
  });
});
