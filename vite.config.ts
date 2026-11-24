import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");

export default defineConfig({
  server: { host: true },
  plugins: [{
    name: "save-trials",
    configureServer(server) {
      server.middlewares.use("/api/save-trials", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
          try {
            const { sessionId, records } = JSON.parse(body);
            if (!/^[\w-]+$/.test(sessionId) || !Array.isArray(records)) throw new Error("bad payload");
            const cols = ["session_id", ...Object.keys(records[0] ?? {})];
            const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
            const lines = [cols, ...records.map((r: Record<string, unknown>) => [sessionId, ...cols.slice(1).map(k => r[k])])];
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(path.join(DATA_DIR, `${sessionId}.csv`), lines.map(l => l.map(esc).join(",")).join("\r\n"));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ count: records.length }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      });
    },
  }],
});
