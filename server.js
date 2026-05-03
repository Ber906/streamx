const path = require("path");
const express = require("express");
const apiHandler = require("./api/index.js");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.all("/api", (req, res) => apiHandler(req, res));
app.all("/api/*", (req, res) => apiHandler(req, res));

app.use(express.static(path.join(__dirname), { etag: false, lastModified: false, maxAge: 0 }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, HOST, () => {
  console.log("StreamX listening on http://" + HOST + ":" + PORT);
  if (!process.env.DATABASE_URL) {
    console.log("Note: DATABASE_URL not set — auth and watchlist require a database.");
  }
});
