import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSpec, orderedTests, parseSpec } from "../src/spec.js";

describe("spec parsing", () => {
  it("normalizes natural-language shorthand and orders dependencies", () => {
    const spec = parseSpec({
      name: "suite",
      tests: [
        { id: "checkout", dependsOn: ["login"], steps: ["Buy the item"] },
        { id: "login", steps: ["Sign in"], assertions: ["The account is signed in"] },
      ],
    });
    expect(spec.tests[0]?.steps[0]).toEqual({ do: "Buy the item" });
    expect(spec.tests[1]?.assertions[0]).toEqual({ expect: "The account is signed in", timing: "end" });
    expect(orderedTests(spec).map((test) => test.id)).toEqual(["login", "checkout"]);
  });

  it("rejects cycles", () => {
    expect(() => parseSpec({
      name: "suite",
      tests: [
        { id: "a", dependsOn: ["b"], steps: ["A"] },
        { id: "b", dependsOn: ["a"], steps: ["B"] },
      ],
    })).toThrow(/cycle/i);
  });

  it("finds a conventional spec from a nested working directory", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "sayspec-find-")));
    await mkdir(path.join(root, "a", "b"), { recursive: true });
    await writeFile(path.join(root, "sayspec.yaml"), "name: x\ntests: []\n");
    await expect(findSpec(undefined, path.join(root, "a", "b"))).resolves.toBe(path.join(root, "sayspec.yaml"));
  });

  it("rejects conflicting literal and environment inputs", () => {
    expect(() => parseSpec({ name: "suite", tests: [{ id: "a", steps: [{ do: "Type", input: "x", inputEnv: "X" }] }] })).toThrow(/both input and inputEnv/);
  });
});
