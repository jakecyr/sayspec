import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("examples/fixtures");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = pathname === "/" ? "actions.html" : pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
    response.writeHead(400).end("Bad request");
    return;
  }
  try {
    const content = await readFile(path.join(root, file));
    response.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain" }).end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(4173, "127.0.0.1", () => console.log("Fixture site: http://127.0.0.1:4173/actions.html"));
