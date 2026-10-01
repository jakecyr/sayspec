import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactRecorder } from "../src/artifacts.js";
import type { BrowserSession } from "../src/browser.js";

let ffmpegAvailable = true;
try {
  execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpegAvailable = false;
}

describe("ArtifactRecorder", () => {
  it.runIf(ffmpegAvailable)("turns ordered screenshots into an animated GIF", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jev-artifacts-"));
    try {
      const recorder = new ArtifactRecorder(root, "run", "gif");
      await recorder.start();
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const browser = { screenshot: async (file: string) => writeFile(file, png) } as unknown as BrowserSession;
      await recorder.capture(browser);
      await recorder.capture(browser);
      const output = await recorder.gif();
      expect(output).toBeDefined();
      expect((await readFile(output!)).subarray(0, 3).toString()).toBe("GIF");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
