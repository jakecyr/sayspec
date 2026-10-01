import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserContextOptions, type Frame, type Page } from "playwright";
import type { AllowedKey, BrowserName, Observation, ObservedElement, Operation } from "./types.js";

type SnapshotElement = Omit<ObservedElement, "id" | "frameId">;

export class StaleObservationError extends Error {}

export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface BrowserSessionOptions {
  cdpUrl?: string;
  executablePath?: string;
  userDataDir?: string;
  storageState?: BrowserStorageState;
}

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page: Page | undefined;
  private observationCounter = 0;
  private connectedOverCdp = false;
  private ownsPage = false;

  constructor(
    private readonly browserName: BrowserName,
    private readonly headless: boolean,
    private readonly timeoutMs: number,
    private readonly options: BrowserSessionOptions = {},
  ) {}

  private braveExecutable(): string {
    if (this.options.executablePath) return path.resolve(this.options.executablePath);
    const candidates = process.platform === "darwin"
      ? ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", path.join(os.homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser")]
      : process.platform === "win32"
        ? [path.join(process.env.PROGRAMFILES ?? "", "BraveSoftware/Brave-Browser/Application/brave.exe"), path.join(process.env.LOCALAPPDATA ?? "", "BraveSoftware/Brave-Browser/Application/brave.exe")]
        : ["/usr/bin/brave-browser", "/usr/bin/brave", "/snap/bin/brave"];
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error("Brave was not found; set executablePath or use --executable-path");
    return executable;
  }

  async start(): Promise<void> {
    if (this.options.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.options.cdpUrl);
      this.connectedOverCdp = true;
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.page = await this.context.newPage();
      this.ownsPage = true;
      this.page.setDefaultTimeout(this.timeoutMs);
      return;
    }
    const browserType = this.browserName === "brave" ? chromium : { chromium, firefox, webkit }[this.browserName];
    const executablePath = this.browserName === "brave" ? this.braveExecutable() : this.options.executablePath;
    const launchOptions: { headless: boolean; executablePath?: string } = { headless: this.headless };
    if (executablePath !== undefined) launchOptions.executablePath = executablePath;
    const contextOptions: BrowserContextOptions = {
      viewport: { width: 1280, height: 720 },
      reducedMotion: "reduce",
    };
    if (this.options.storageState !== undefined) contextOptions.storageState = this.options.storageState;
    if (this.options.userDataDir) {
      this.context = await browserType.launchPersistentContext(path.resolve(this.options.userDataDir), { ...launchOptions, ...contextOptions });
    } else {
      this.browser = await browserType.launch(launchOptions);
      this.context = await this.browser.newContext(contextOptions);
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.ownsPage = this.context.pages().length === 1 && this.page.url() === "about:blank";
    this.context.on("page", (page) => {
      this.page = page;
      page.setDefaultTimeout(this.timeoutMs);
    });
    this.page.setDefaultTimeout(this.timeoutMs);
  }

  currentPage(): Page {
    if (!this.page) throw new Error("Browser session has not started");
    return this.page;
  }

  async goto(url: string): Promise<void> {
    await this.currentPage().goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
  }

  async observe(): Promise<Observation> {
    const page = this.currentPage();
    const observationId = `o${++this.observationCounter}`;
    const frames = new Map<string, Frame>();
    const elements: ObservedElement[] = [];
    const textParts: string[] = [];

    for (const [frameIndex, frame] of page.frames().entries()) {
      const frameId = `f${frameIndex}`;
      try {
        const snapshot = await frame.evaluate((prefix) => {
          const clean = (value: string | null | undefined, max = 180) =>
            (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
          const visible = (element: Element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight;
          };
          const focused = (element: Element) => {
            let active: Element | null = document.activeElement;
            while (active) {
              if (active === element) return true;
              active = active.shadowRoot?.activeElement ?? null;
            }
            return false;
          };
          const roots: Array<Document | ShadowRoot> = [document];
          const all: Element[] = [];
          for (let i = 0; i < roots.length; i++) {
            const root = roots[i]!;
            for (const element of root.querySelectorAll("*")) {
              all.push(element);
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
          const text = clean([...document.querySelectorAll("body *")]
            .filter((element) => visible(element) && element.children.length === 0)
            .map((element) => element.textContent)
            .filter(Boolean).join(" | "), 8_000);
          const actionable = all.filter((element) => {
            const fileInput = element.matches("input[type=file]");
            if ((!visible(element) && !fileInput) || element.getAttribute("aria-hidden") === "true") return false;
            if (element.matches("button,a[href],input:not([type=hidden]),textarea,select,[contenteditable=true],[draggable=true],[ondrop],[data-dropzone]")) return true;
            return ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox"].includes(element.getAttribute("role") ?? "");
          }).slice(0, 180);
          const elements: SnapshotElement[] = actionable.flatMap((element, index) => {
            const html = element as HTMLElement;
            const input = element as HTMLInputElement;
            const select = element as HTMLSelectElement;
            const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
            const associated = "labels" in input && input.labels ? [...input.labels].map((label) => label.textContent).join(" ") : "";
            const baseLabel = clean(element.getAttribute("aria-label") || labelledBy || associated || element.getAttribute("placeholder") || element.getAttribute("title") || html.innerText || element.textContent || element.getAttribute("name") || element.tagName.toLowerCase());
            const container = element.closest("fieldset,[role=dialog],[role=group],form,li,tr");
            const containerLabel = container && container !== element ? clean((container as HTMLElement).innerText || container.textContent, 100) : "";
            const label = containerLabel && containerLabel !== baseLabel && !baseLabel.includes(containerLabel)
              ? `${baseLabel} · in ${containerLabel}`.slice(0, 180)
              : baseLabel;
            const role = element.getAttribute("role") || (element.tagName === "A" ? "link" : element.tagName === "SELECT" ? "combobox" : element.tagName.toLowerCase());
            const nodeId = `${prefix}-${index}`;
            element.setAttribute("data-sayspec-id", nodeId);
            const fillable = element.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]),textarea,[contenteditable=true],[role=textbox],[role=combobox]");
            const operations: Operation[] = [];
            if (input.type === "file") operations.push("UPLOAD_FILE");
            else if (element.tagName === "SELECT") operations.push("SELECT", "HOVER");
            else if (input.type === "checkbox" || role === "checkbox" || role === "switch") {
              operations.push(input.checked || element.getAttribute("aria-checked") === "true" ? "UNCHECK" : "CHECK", "HOVER");
            }
            else {
              operations.push("CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "HOVER");
              if (fillable) operations.push("TYPE_TEXT");
            }
            if (element.getAttribute("draggable") === "true") operations.push("DRAG_DROP");
            const password = input.type === "password" || ["current-password", "new-password", "one-time-code"].includes(input.autocomplete);
            const result: SnapshotElement = {
              nodeId,
              role,
              label,
              disabled: input.disabled || element.getAttribute("aria-disabled") === "true",
              operations,
              signature: `${element.tagName}|${role}|${label}`,
            };
            if ("value" in input) result.value = password ? "[redacted]" : clean(input.value, 120);
            if ("checked" in input && ["checkbox", "radio"].includes(input.type)) result.checked = input.checked;
            if (focused(element)) result.focused = true;
            if (element.tagName === "SELECT") result.options = [...select.options].slice(0, 80).map((option, optionIndex) => ({ index: optionIndex, label: clean(option.textContent || option.label || option.value), selected: option.selected }));
            return [result];
          });
          const scrollables = all.filter((element) => visible(element) && element.scrollHeight > element.clientHeight + 20);
          for (const [scrollIndex, element] of scrollables.slice(0, 30).entries()) {
            let nodeId = element.getAttribute("data-sayspec-id");
            let result = elements.find((candidate) => candidate.nodeId === nodeId);
            if (!nodeId) {
              nodeId = `${prefix}-s${scrollIndex}`;
              element.setAttribute("data-sayspec-id", nodeId);
            }
            if (!result) {
              const label = clean(element.getAttribute("aria-label") || (element as HTMLElement).innerText || element.textContent || "scrollable region");
              result = { nodeId, role: element.getAttribute("role") || "region", label, disabled: false, operations: [], signature: `${element.tagName}|${element.getAttribute("role") || "region"}|${label}` };
              elements.push(result);
            }
            result.value = `scroll ${Math.round(element.scrollTop)}/${element.scrollHeight}`;
            if (element.scrollTop > 1) result.operations.push("SCROLL_UP");
            if (element.scrollTop + element.clientHeight < element.scrollHeight - 1) result.operations.push("SCROLL_DOWN");
          }
          const root = document.scrollingElement;
          if (root && root.scrollHeight > innerHeight + 20) {
            const operations: Operation[] = [];
            if (root.scrollTop > 1) operations.push("SCROLL_UP");
            if (root.scrollTop + innerHeight < root.scrollHeight - 1) operations.push("SCROLL_DOWN");
            elements.push({ nodeId: "$page", role: "document", label: "main page", value: `scroll ${Math.round(root.scrollTop)}/${root.scrollHeight}`, disabled: false, operations, signature: "$page" });
          }
          return { text, elements };
        }, `${observationId}-${frameId}`) as { text: string; elements: SnapshotElement[] };
        frames.set(frameId, frame);
        textParts.push(snapshot.text);
        for (const element of snapshot.elements) elements.push({ ...element, id: `${frameId}:${element.nodeId}`, frameId });
      } catch {
        // Cross-process or navigating frames can disappear during a snapshot.
      }
    }

    const livePages = (this.context?.pages() ?? [page]).filter((candidate) => !candidate.isClosed());
    const tabPages = new Map(livePages.map((candidate, index) => [index, candidate]));
    const tabs = await Promise.all(livePages.map(async (candidate, index) => ({
      index,
      title: await candidate.title().catch(() => ""),
      url: candidate.url(),
      active: candidate === page,
    })));
    const fingerprint = createHash("sha1").update(JSON.stringify({
      url: page.url(),
      text: textParts.join("\n").slice(0, 12_000),
      elements: elements.map(({ id, value, checked, focused, operations }) => ({ id, value, checked, focused, operations })),
      tabs,
    })).digest("hex");
    return {
      url: page.url(),
      title: await page.title(),
      text: textParts.join("\n").slice(0, 12_000),
      elements,
      frames,
      tabPages,
      tabs,
      observedAt: new Date().toISOString(),
      fingerprint,
    };
  }

  async execute(observation: Observation, operation: Operation, elementId?: string, optionIndex?: number, text?: string, key?: AllowedKey, tabIndex?: number): Promise<void> {
    if (operation === "WAIT") {
      await this.currentPage().waitForTimeout(300);
      return;
    }
    if (this.currentPage().url() !== observation.url) throw new StaleObservationError("Page URL changed before execution");
    if (operation === "BACK") {
      await this.currentPage().goBack({ waitUntil: "domcontentloaded" });
      return;
    }
    if (operation === "FORWARD") {
      await this.currentPage().goForward({ waitUntil: "domcontentloaded" });
      return;
    }
    if (operation === "RELOAD") {
      await this.currentPage().reload({ waitUntil: "domcontentloaded" });
      return;
    }
    if (operation === "PRESS_KEY") {
      if (!key) throw new Error("Jev did not select an allowed key");
      await this.currentPage().keyboard.press(key);
      await this.currentPage().waitForTimeout(50);
      return;
    }
    if (operation === "SWITCH_TAB") {
      const selected = tabIndex === undefined ? undefined : observation.tabPages.get(tabIndex);
      if (!selected || selected.isClosed()) throw new StaleObservationError("Jev selected a stale browser tab");
      this.page = selected;
      await selected.bringToFront();
      return;
    }
    if (operation === "CLOSE_TAB") {
      if ((this.context?.pages().length ?? 0) < 2) throw new Error("Refusing to close the only browser tab");
      await this.currentPage().close();
      this.page = this.context!.pages().find((candidate) => !candidate.isClosed());
      if (!this.page) throw new Error("No browser tab remains after closing the tab");
      return;
    }
    if ((operation === "SCROLL_UP" || operation === "SCROLL_DOWN") && !elementId) {
      throw new Error("Jev chose scrolling without a scroll target");
    }
    if ((operation === "SCROLL_UP" || operation === "SCROLL_DOWN") && elementId) {
      const element = observation.elements.find((candidate) => candidate.id === elementId);
      if (!element) throw new Error("Jev selected an unknown scroll target");
      const frame = observation.frames.get(element.frameId);
      if (!frame || frame.isDetached()) throw new StaleObservationError("Page changed before scrolling");
      const delta = operation === "SCROLL_UP" ? -560 : 560;
      if (element.nodeId === "$page") await frame.evaluate((amount) => window.scrollBy(0, amount), delta);
      else await frame.locator(`[data-sayspec-id="${element.nodeId}"]`).evaluate((node, amount) => node.scrollBy(0, amount), delta);
      await this.currentPage().waitForTimeout(50);
      return;
    }
    const element = observation.elements.find((candidate) => candidate.id === elementId);
    if (!element) throw new Error(`Jev selected an unknown element: ${String(elementId)}`);
    if (!element.operations.includes(operation)) throw new Error(`${operation} is not valid for ${element.label}`);
    const frame = observation.frames.get(element.frameId);
    if (!frame || frame.isDetached()) throw new StaleObservationError("Page changed before the selected action could run");
    const locator = frame.locator(`[data-sayspec-id="${element.nodeId}"]`);
    if (await locator.count() !== 1 || (operation !== "UPLOAD_FILE" && !(await locator.isVisible())) || !(await locator.isEnabled())) throw new StaleObservationError("Selected element is stale, hidden, or disabled");
    const signature = await locator.evaluate((node) => {
      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
      const html = node as HTMLElement;
      const input = node as HTMLInputElement;
      const labelledBy = node.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const associated = "labels" in input && input.labels ? [...input.labels].map((label) => label.textContent).join(" ") : "";
      const baseLabel = clean(node.getAttribute("aria-label") || labelledBy || associated || node.getAttribute("placeholder") || node.getAttribute("title") || html.innerText || node.textContent || node.getAttribute("name") || node.tagName.toLowerCase());
      const container = node.closest("fieldset,[role=dialog],[role=group],form,li,tr");
      const containerLabel = container && container !== node ? clean((container as HTMLElement).innerText || container.textContent).slice(0, 100) : "";
      const label = containerLabel && containerLabel !== baseLabel && !baseLabel.includes(containerLabel)
        ? `${baseLabel} · in ${containerLabel}`.slice(0, 180)
        : baseLabel;
      const role = node.getAttribute("role") || (node.tagName === "A" ? "link" : node.tagName === "SELECT" ? "combobox" : node.tagName.toLowerCase());
      return `${node.tagName}|${role}|${label}`;
    });
    if (signature !== element.signature) throw new StaleObservationError("Selected element changed before execution");
    if (operation === "CLICK") await locator.click();
    if (operation === "DOUBLE_CLICK") await locator.dblclick();
    if (operation === "RIGHT_CLICK") await locator.click({ button: "right" });
    if (operation === "HOVER") await locator.hover();
    if (operation === "CHECK") await locator.check();
    if (operation === "UNCHECK") await locator.uncheck();
    if (operation === "TYPE_TEXT") {
      if (!text) throw new Error("Text helper did not provide a value");
      await locator.fill(text);
    }
    if (operation === "SELECT") {
      if (optionIndex === undefined) throw new Error("Jev did not select a dropdown option");
      await locator.selectOption({ index: optionIndex });
    }
    if (operation === "UPLOAD_FILE") {
      if (!text) throw new Error("UPLOAD_FILE requires user-authored file paths");
      await locator.setInputFiles(JSON.parse(text) as string[]);
    }
    if (operation === "DRAG_DROP") {
      if (!text) throw new Error("DRAG_DROP requires an observed drop target id");
      const drop = observation.elements.find((candidate) => candidate.id === text);
      if (!drop) throw new Error("Jev selected an unknown drop target");
      const dropFrame = observation.frames.get(drop.frameId);
      if (!dropFrame || dropFrame !== frame) throw new Error("Cross-frame drag and drop is not supported");
      const dropLocator = dropFrame.locator(`[data-sayspec-id="${drop.nodeId}"]`);
      if (await dropLocator.count() !== 1 || !(await dropLocator.isVisible()) || !(await dropLocator.isEnabled())) throw new StaleObservationError("Drop target is stale, hidden, or disabled");
      await locator.dragTo(dropLocator);
    }
    await this.currentPage().waitForTimeout(operation === "TYPE_TEXT" ? 150 : 50);
  }

  async screenshot(file: string): Promise<void> {
    await this.currentPage().screenshot({ path: file, fullPage: false });
  }

  async storageState(): Promise<BrowserStorageState> {
    if (!this.context) throw new Error("Browser session has not started");
    return this.context.storageState({ indexedDB: true });
  }

  async resetTabs(): Promise<void> {
    const pages = (this.context?.pages() ?? []).filter((page) => !page.isClosed());
    const keep = this.page && !this.page.isClosed() ? this.page : pages[0];
    for (const page of pages) if (page !== keep) await page.close();
    if (keep) this.page = keep;
  }

  async close(): Promise<void> {
    if (this.connectedOverCdp) {
      if (this.ownsPage && this.page && !this.page.isClosed()) await this.page.close();
      // Playwright exposes no public CDP disconnect. Closing its private transport
      // detaches without sending Browser.close to the user's running browser.
      const connection = (this.browser as unknown as { _connection?: { close(): void } } | undefined)?._connection;
      connection?.close();
      return;
    }
    if (this.browser) await this.browser.close();
    else await this.context?.close();
  }
}
