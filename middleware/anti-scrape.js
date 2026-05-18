"use strict";

const RICKROLL_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function rickRoll(req, res) {
  const ua = req.headers["user-agent"] || "";
  const acceptsHtml = (req.headers["accept"] || "").includes("text/html");
  const isHeadless = !acceptsHtml || /headless|curl|wget|python|scrapy|axios\/\d/i.test(ua);

  if (isHeadless) {
    res.statusCode = 302;
    res.setHeader("Location", RICKROLL_URL);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      success: false,
      message: "Never gonna give you up, never gonna let you down \uD83C\uDFB5",
      hint: RICKROLL_URL,
    }));
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>StreamX \u2014 Access Denied</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#000;color:#fff;font-family:system-ui,sans-serif;
         display:flex;flex-direction:column;align-items:center;
         justify-content:center;min-height:100vh;text-align:center;gap:16px}
    h1{font-size:1.6rem;color:#e8192c}
    p{color:rgba(255,255,255,.6);font-size:.95rem}
    .frame{width:min(560px,95vw);aspect-ratio:16/9;border:none;border-radius:12px}
  </style>
</head>
<body>
  <h1>\uD83C\uDFB5 Never Gonna Give You Up</h1>
  <p>Scraping detected. Enjoy your reward.</p>
  <iframe class="frame"
    src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"
    allow="autoplay; encrypted-media" allowfullscreen></iframe>
  <p style="font-size:.8rem;margin-top:8px">\u2014 StreamX Security Team</p>
</body>
</html>`);
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 80;
const ipStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipStore) {
    if (entry.resetAt <= now) ipStore.delete(ip);
  }
}, 5 * 60 * 1000);

function getRealIp(req) {
  const forwarded =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown";
  return String(forwarded).split(",")[0].trim();
}

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = ipStore.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    ipStore.set(ip, entry);
    return { limited: false, remaining: RATE_LIMIT_MAX - 1 };
  }
  entry.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  return { limited: entry.count > RATE_LIMIT_MAX, remaining, resetAt: entry.resetAt };
}

const BOT_UA_PATTERNS = [
  /bot/i, /crawl/i, /spider/i, /scrape/i, /slurp/i, /wget/i, /curl/i,
  /python-requests/i, /python-urllib/i, /go-http-client/i, /java\//i,
  /libwww-perl/i, /httpclient/i, /okhttp/i, /axios\/\d/i, /node-fetch/i,
  /scrapy/i, /mechanize/i, /phantomjs/i, /headless/i, /selenium/i,
  /puppeteer/i, /playwright/i, /cypress/i, /htmlunit/i, /ruby/i,
  /postman/i, /insomnia/i, /httpie/i, /dataprovider/i, /yandex/i,
  /baiduspider/i, /sogou/i, /exabot/i, /facebot/i, /ia_archiver/i,
];

function isBot(ua) {
  if (!ua || ua.trim() === "") return true;
  return BOT_UA_PATTERNS.some((p) => p.test(ua));
}

function hasValidOrigin(req) {
  const auth = req.headers["authorization"] || "";
  if (/^Bearer\s+\S+/i.test(auth)) return true;
  const host    = req.headers["host"]    || "";
  const origin  = req.headers["origin"]  || "";
  const referer = req.headers["referer"] || "";
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return true;
      if (/^localhost(:\d+)?$/.test(originHost)) return true;
    } catch { /* malformed */ }
  }
  if (referer) {
    try {
      const refHost = new URL(referer).host;
      if (refHost === host) return true;
      if (/^localhost(:\d+)?$/.test(refHost)) return true;
    } catch { /* malformed */ }
  }
  if (req.method === "OPTIONS") return true;
  return false;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options",  "nosniff");
  res.setHeader("X-XSS-Protection",        "1; mode=block");
  res.setHeader("Referrer-Policy",         "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy",      "camera=(), microphone=(), geolocation=()");
}

function antiScrapeMiddleware(req, res, next) {
  applySecurityHeaders(res);
  const ip  = getRealIp(req);
  const ua  = req.headers["user-agent"] || "";
  const url = req.url || "";
  const { limited, remaining, resetAt } = checkRateLimit(ip);
  res.setHeader("X-RateLimit-Limit",     String(RATE_LIMIT_MAX));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  if (resetAt) res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  if (limited) return rickRoll(req, res);
  const isStaticAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(url);
  if (isStaticAsset) return next();
  if (isBot(ua)) return rickRoll(req, res);
  const isApiRoute = url.startsWith("/api");
  if (isApiRoute) {
    const sub = url.replace(/^\/api\/?/, "").split("?")[0].toLowerCase();
    const exempted = sub === "health" || sub.startsWith("auth/");
    if (!exempted && !hasValidOrigin(req)) return rickRoll(req, res);
  }
  next();
}

module.exports = antiScrapeMiddleware;
