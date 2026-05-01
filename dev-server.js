// Local dev server — simulates Vercel routing.
// Serves index.html at / and forwards /api/* to api/index.js.
// Use `npm run dev`. Reads env vars (DATABASE_URL, OPENAI_API_KEY, JWT_SECRET, …).

const path = require("path");
const express = require("express");
const apiHandler = require("./api/index.js");

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

app.all("/api", (req, res) => apiHandler(req, res));
app.all("/api/*", (req, res) => apiHandler(req, res));

app.use(express.static(path.join(__dirname), { etag: false, lastModified: false, maxAge: 0 }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, HOST, () => {
  console.log(`StreamX dev server listening on http://${HOST}:${PORT}`);
  if (!process.env.DATABASE_URL) console.log("⚠  DATABASE_URL not set — auth and watchlist will fail.");
  const aiOk = process.env.OPENAI_API_KEY || (process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.AI_INTEGRATIONS_OPENAI_BASE_URL);
  if (!aiOk) console.log("ℹ  No AI provider configured — set OPENAI_API_KEY to enable the AI chat.");
});
