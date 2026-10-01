import { describe, expect, it, vi } from "vitest";
import { LlmClient } from "../src/llm.js";
import type { Observation } from "../src/types.js";

const observation: Observation = {
  url: "https://example.test",
  title: "Example",
  text: "Product search",
  observedAt: new Date(0).toISOString(),
  fingerprint: "fixture",
  frames: new Map(),
  tabPages: new Map(),
  tabs: [{ index: 0, title: "Example", url: "https://example.test", active: true }],
  elements: [{
    id: "f0:search",
    frameId: "f0",
    nodeId: "search",
    role: "textbox",
    label: "Search products",
    value: "",
    disabled: false,
    operations: ["CLICK", "TYPE_TEXT"],
    signature: "INPUT|textbox|Search products",
  }],
};

function choicesFromPrompt(content: string, selected: Record<string, string>): string {
  const task = JSON.parse(content) as { questions: Record<string, { options: Record<string, unknown> }> };
  for (const [name, choice] of Object.entries(selected)) expect(Object.keys(task.questions[name]!.options)).toContain(choice);
  return JSON.stringify({ answers: selected });
}

describe("LlmClient", () => {
  it("uses an OpenAI-compatible endpoint and decodes strict choices", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://model.test/v1/chat/completions");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string; response_format?: { type?: string }; messages: Array<{ content: string }> };
      expect(body.reasoning_effort).toBe("low");
      expect(body.response_format?.type).toBe("json_schema");
      const content = choicesFromPrompt(body.messages[1]!.content, { status: "ACTION", operation: "TYPE_TEXT", press_key_target: "Enter" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    const client = new LlmClient({ provider: "openai", apiKey: "secret", baseUrl: "http://model.test/v1", model: "test-model", reasoning: "low", fetch: fetcher });

    await expect(client.decide({ do: "Type keyboard into Search products", input: "keyboard" }, observation, [])).resolves.toMatchObject({
      status: "ACTION",
      operation: "TYPE_TEXT",
      elementId: "f0:search",
    });
  });

  it("uses the Anthropic Messages API", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://anthropic.test/v1/messages");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("anthropic-secret");
      const body = JSON.parse(String(init?.body)) as { output_config?: { format?: { type?: string } }; messages: Array<{ content: string }> };
      expect(body.output_config?.format?.type).toBe("json_schema");
      const content = choicesFromPrompt(body.messages[0]!.content, { assertion: "PASS" });
      return new Response(JSON.stringify({ content: [{ type: "text", text: content }] }), { status: 200 });
    }) as typeof fetch;
    const client = new LlmClient({ provider: "anthropic", apiKey: "anthropic-secret", baseUrl: "https://anthropic.test/v1", model: "claude-test", fetch: fetcher });

    await expect(client.assert("Search is visible", observation, "test")).resolves.toEqual({ passed: true, confidence: 1 });
  });

  it("rejects model output outside the offered choices", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answers: { assertion: "MAYBE" } }) } }],
    }), { status: 200 })) as typeof fetch;
    const client = new LlmClient({ provider: "openai", apiKey: "secret", model: "test-model", fetch: fetcher });

    await expect(client.assert("Search is visible", observation, "test")).rejects.toThrow(/invalid assertion choice/);
  });
});
