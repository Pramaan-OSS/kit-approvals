// Local test double for the platform's email and file modules.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
export async function startFakeDoor(dir) {
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  writeFileSync(path.join(dir, "token"), token);
  const sock = path.join(dir, "modules.sock");
  rmSync(sock, { force: true });
  const state = { mail: [], files: new Map(), emailOn: true, filesOn: true };
  const keys = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "MODULE_TOKEN_INVALID" });
    if (req.url === "/v1/email" && req.method === "POST") {
      if (!state.emailOn) return send(404, { error: "MODULE_OFF" });
      const key = req.headers["idempotency-key"];
      if (!keys.has(key)) {
        state.mail.push({ ...JSON.parse(body.toString()), key });
        keys.add(key);
      }
      return send(202, { accepted: true });
    }
    if (req.url.startsWith("/v1/files/")) {
      if (!state.filesOn) return send(404, { error: "MODULE_OFF" });
      const key = decodeURIComponent(req.url.slice("/v1/files/".length));
      if (req.method === "PUT") {
        state.files.set(key, body);
        return send(201, { key });
      }
      if (req.method === "GET") {
        if (!state.files.has(key)) return send(404, { error: "FILE_NOT_FOUND" });
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(state.files.get(key));
      }
    }
    return send(404, { error: "NOT_FOUND" });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  return { state, close: () => new Promise((resolve) => server.close(resolve)) };
}
