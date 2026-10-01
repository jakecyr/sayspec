import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { BrowserSession } from "./browser.js";
import type { HistoryEntry } from "./types.js";

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
}

export class ArtifactRecorder {
  readonly directory: string;
  private frame = 0;

  constructor(root: string, runId: string, testId: string) {
    this.directory = path.resolve(root, safeName(runId), safeName(testId));
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async capture(browser: BrowserSession): Promise<void> {
    this.frame += 1;
    await browser.screenshot(path.join(this.directory, `frame-${String(this.frame).padStart(4, "0")}.png`));
  }

  async trace(history: HistoryEntry[], error?: string): Promise<void> {
    await writeFile(path.join(this.directory, "trace.json"), JSON.stringify({ error, history }, null, 2));
  }

  async gif(): Promise<string | undefined> {
    if (this.frame === 0) return undefined;
    const output = path.join(this.directory, "run.gif");
    const args = [
      "-y", "-framerate", "2", "-i", path.join(this.directory, "frame-%04d.png"),
      "-vf", "fps=2,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
      "-loop", "0", output,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { stdio: "ignore" });
      child.once("error", (error) => reject(new Error(`Could not create GIF: ${error.message}`)));
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
    });
    return output;
  }

  async discard(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}
