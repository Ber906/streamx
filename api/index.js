// StreamX — single backend (Vercel serverless function)
//
// Auth:
//   POST /api/auth/signup   { email, password, name? }
//   POST /api/auth/login    { email, password }
//   GET  /api/auth/me       (Bearer token)
//
// Catalog (no auth required):
//   GET  /api/trending      — TMDB trending (movies + tv)
//   GET  /api/list          — TMDB popular + top-rated movies
//   GET  /api/tv-series     — TMDB popular + top-rated TV
//   GET  /api/anime         — Jikan/MyAnimeList top + seasonal
//   GET  /api/anilist       — AniList trending anime (GraphQL)
//   GET  /api/tvmaze        — TVmaze shows
//   GET  /api/search?q=…    — multi-source search
//   GET  /api/detail?id&type
//   GET  /api/resolve?title&type
//
// Watchlist (auth required):
//   GET    /api/watchlist
//   POST   /api/watchlist   { item }
//   DELETE /api/watchlist   { id }
//
// Watch History (auth required):
//   GET    /api/history
//   POST   /api/history     { item }
//   DELETE /api/history     { id }
//
// Community Chat (auth required):
//   GET    /api/chat?limit=60
//   POST   /api/chat        { message }
//
// AI (auth required):
//   POST /api/ai/chat       { messages: [{ role, content }] }
//
// Admin (secret key required):
//   GET    /api/admin/users
//   DELETE /api/admin/users/delete { id }

const axios = require("axios");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// ── Hardcoded fallback credentials ───────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://neondb_owner:npg_YuqP3NzC2jrL@ep-sweet-cell-amglfgig-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"; // neon db
}
if (!process.env.GEMINI_API_KEY) {
  process.env.GEMINI_API_KEY = "AIzaSyAdmBmnk6fnng_oUvym88N1IEyxeYI6ffE";
}

// ─── Anti-Scrape (inlined for Vercel serverless) ──────────────────────────────
const RICKROLL_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const BOT_UA_PATTERNS = [
  /bot/i, /crawl/i, /spider/i, /scrape/i, /slurp/i, /wget/i, /curl/i,
  /python-requests/i, /python-urllib/i, /go-http-client/i, /java\//i,
  /libwww-perl/i, /httpclient/i, /okhttp/i, /axios\/\d/i, /node-fetch/i,
  /scrapy/i, /mechanize/i, /phantomjs/i, /headless/i, /selenium/i,
  /puppeteer/i, /playwright/i, /cypress/i, /htmlunit/i,
  /postman/i, /insomnia/i, /httpie/i, /dataprovider/i, /yandex/i,
  /baiduspider/i, /sogou/i, /exabot/i, /ia_archiver/i,
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
      const oh = new URL(origin).host;
      if (oh === host || /^localhost(:\d+)?$/.test(oh)) return true;
    } catch { /* malformed */ }
  }
  if (referer) {
    try {
      const rh = new URL(referer).host;
      if (rh === host || /^localhost(:\d+)?$/.test(rh)) return true;
    } catch { /* malformed */ }
  }
  return false;
}
function rickRoll(req, res) {
  const ua          = req.headers["user-agent"] || "";
  const acceptsHtml = (req.headers["accept"] || "").includes("text/html");
  const isHeadless  = !acceptsHtml || /headless|curl|wget|python|scrapy|axios\/\d/i.test(ua);
  if (isHeadless) {
    res.statusCode = 302;
    res.setHeader("Location", RICKROLL_URL);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, message: "Never gonna give you up \uD83C\uDFB5", hint: RICKROLL_URL }));
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.end(`<!doctype html><html><head><meta charset="utf-8"/><title>Denied</title></head><body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;font-family:sans-serif;text-align:center"><h1 style="color:#e8192c">\uD83C\uDFB5 Never Gonna Give You Up</h1><p style="color:rgba(255,255,255,.6)">Scraping detected.</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1" style="width:min(560px,95vw);aspect-ratio:16/9;border:none" allow="autoplay" allowfullscreen></iframe></body></html>`);
}

// ─── DB ──────────────────────────────────────────────────────────────────────
let pool = null;
function db() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  pool = new Pool({
    connectionString: url,
    ssl: url.includes("sslmode=require") || /neon\.tech|supabase\.co|vercel-storage/.test(url)
      ? { rejectUnauthorized: false } : undefined,
    max: 3,
  });
  return pool;
}

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await db().query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id      TEXT NOT NULL,
      title        TEXT NOT NULL,
      cover        TEXT,
      backdrop     TEXT,
      tmdb_id      TEXT,
      type         INTEGER DEFAULT 1,
      media_type   TEXT,
      genre        TEXT,
      release_date  TEXT,
      imdb_rating   TEXT,
      description   TEXT,
      source       TEXT,
      added_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS watchlist_user_added_idx ON watchlist (user_id, added_at DESC);
    CREATE TABLE IF NOT EXISTS watch_history (
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id      TEXT NOT NULL,
      title        TEXT NOT NULL,
      cover        TEXT,
      media_type   TEXT,
      tmdb_id      TEXT,
      source       TEXT,
      season       INTEGER DEFAULT 1,
      episode      INTEGER DEFAULT 1,
      progress_pct INTEGER DEFAULT 0,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS watch_history_user_idx ON watch_history (user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS community_chat (
      id         BIGSERIAL PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name  TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS comm_chat_created_idx ON community_chat (created_at DESC);
  `);
  schemaReady = true;
}

// ─── Auth helpers ────────────────────────────────────────────────────────────
function jwtSecret() {
  const base = process.env.JWT_SECRET
    || process.env.SESSION_SECRET
    || process.env.DATABASE_URL
    || "streamx-local-dev-only";
  return crypto.createHash("sha256").update(base + "_streamx_v1").digest("hex");
}
function sign(user) {
  return jwt.sign({ uid: user.id, email: user.email }, jwtSecret(), { expiresIn: "30d" });
}
function verify(token) {
  try { return jwt.verify(token, jwtSecret()); } catch { return null; }
}
function bearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
async function currentUser(req) {
  const tok = bearer(req); if (!tok) return null;
  const payload = verify(tok); if (!payload) return null;
  await ensureSchema();
  const r = await db().query(`SELECT id, email, name FROM users WHERE id = $1`, [payload.uid]);
  return r.rows[0] || null;
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }

// ─── TMDB ────────────────────────────────────────────────────────────────────
const IMG_BASE = "https://image.tmdb.org/t/p/w500";
const BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280";
function tmdbKey() { return process.env.TMDB_API_KEY || "a24864295af79f21074d2ebd32333d22"; }

const MOVIE_GENRES = {
  28:"Action",12:"Adventure",16:"Animation",35:"Comedy",80:"Crime",
  99:"Documentary",18:"Drama",10751:"Family",14:"Fantasy",36:"History",
  27:"Horror",10402:"Music",9648:"Mystery",10749:"Romance",878:"Science Fiction",
  10770:"TV Movie",53:"Thriller",10752:"War",37:"Western",
};
const TV_GENRES = {
  10759:"Action & Adventure",16:"Animation",35:"Comedy",80:"Crime",
  99:"Documentary",18:"Drama",10751:"Family",10762:"Kids",9648:"Mystery",
  10763:"News",10764:"Reality",10765:"Sci-Fi & Fantasy",10766:"Soap",
  10767:"Talk",10768:"War & Politics",37:"Western",
};

async function tmdb(path, params = {}) {
  const key = tmdbKey();
  const resp = await axios.get(`https://api.themoviedb.org/3${path}`, {
    params: { api_key: key, ...params }, timeout: 15000,
  });
  return resp.data;
}

function formatItem(raw, forcedType) {
  const mediaType = forcedType || (raw.media_type === "tv" || raw.first_air_date ? "tv" : "movie");
  const isTV = mediaType === "tv";
  const genreMap = isTV ? TV_GENRES : MOVIE_GENRES;
  const genreIds = raw.genre_ids || (raw.genres || []).map((g) => g.id);
  const genre = genreIds.map((id) => genreMap[id]).filter(Boolean).join(", ") || null;
  const cover = raw.poster_path ? `${IMG_BASE}${raw.poster_path}` : null;
  const backdrop = raw.backdrop_path ? `${BACKDROP_BASE}${raw.backdrop_path}` : null;
  const country =
    (Array.isArray(raw.origin_country) ? raw.origin_country[0] : null) ||
    (Array.isArray(raw.production_countries) ? raw.production_countries[0]?.iso_3166_1 : null) || null;
  let seasons = [];
  if (isTV && Array.isArray(raw.seasons)) {
    seasons = raw.seasons.filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({ se: s.season_number, maxEp: s.episode_count }));
  }
  // Detect anime: Animation genre + Japan origin/language
  const isAnime = genreIds.includes(16) &&
    (raw.original_language === "ja" || (Array.isArray(raw.origin_country) && raw.origin_country.includes("JP")));
  return {
    id: String(raw.id), tmdbId: raw.id, mediaType,
    title: raw.title || raw.name || "Unknown",
    description: raw.overview || "",
    releaseDate: raw.release_date || raw.first_air_date || null,
    duration: raw.runtime || (raw.episode_run_time && raw.episode_run_time[0]) || null,
    genre, cover, backdrop, country,
    imdbRating: raw.vote_average ? raw.vote_average.toFixed(1) : null,
    type: isTV ? 2 : 1, seasons, source: "tmdb",
    isAnime: isAnime || false,
  };
}

function formatJikanAnime(raw) {
  return {
    id: `jikan-${raw.mal_id}`, tmdbId: null, malId: raw.mal_id, mediaType: "tv",
    title: raw.title_english || raw.title,
    description: (raw.synopsis || "").replace(/\[Written by.*?\]/gi, "").trim(),
    releaseDate: raw.year ? `${raw.year}-01-01` : null,
    genre: (raw.genres || []).map((g) => g.name).join(", ") || null,
    cover: raw.images?.jpg?.large_image_url || null, backdrop: null,
    country: "Japan",
    imdbRating: raw.score ? raw.score.toFixed(1) : null,
    type: 2, seasons: [], source: "jikan", isAnime: true,
  };
}

function formatAnilistAnime(raw) {
  return {
    id: `anilist-${raw.id}`, tmdbId: null, malId: raw.idMal || null, mediaType: "tv",
    title: raw.title?.english || raw.title?.romaji || "Unknown",
    description: (raw.description || "").replace(/<[^>]*>/g, "").replace(/\(Source:[^)]*\)/gi, "").trim(),
    releaseDate: raw.startDate?.year ? `${raw.startDate.year}-01-01` : null,
    genre: (raw.genres || []).join(", ") || null,
    cover: raw.coverImage?.large || null, backdrop: raw.bannerImage || null,
    country: "Japan",
    imdbRating: raw.averageScore ? (raw.averageScore / 10).toFixed(1) : null,
    type: 2, seasons: [], source: "anilist", isAnime: true,
  };
}

function formatTVmazeShow(raw) {
  const show = raw.show || raw;
  return {
    id: `tvmaze-${show.id}`, tmdbId: null, mediaType: "tv",
    title: show.name,
    description: (show.summary || "").replace(/<[^>]*>/g, ""),
    releaseDate: show.premiered || null,
    genre: (show.genres || []).join(", ") || null,
    cover: show.image?.original || show.image?.medium || null,
    backdrop: null, country: show.network?.country?.code || null,
    imdbRating: show.rating?.average ? show.rating.average.toFixed(1) : null,
    type: 2, seasons: [], source: "tvmaze",
  };
}

// ─── Body & query parsing ────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}
function getQuery(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const out = {};
  url.searchParams.forEach((v, k) => { out[k] = v; });
  return out;
}
function send(res, status, json) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(json));
}

// ─── Catalog handlers ────────────────────────────────────────────────────────
async function trending() {
  const data = await tmdb("/trending/all/week");
  const items = (data.results || [])
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .map((r) => formatItem(r));
  return { success: true, data: items };
}
async function list() {
  const [pop, top] = await Promise.all([
    tmdb("/movie/popular", { page: "1" }),
    tmdb("/movie/top_rated", { page: "1" }),
  ]);
  const seen = new Set(); const items = [];
  for (const r of [...(pop.results || []), ...(top.results || [])]) {
    const k = String(r.id);
    if (!seen.has(k)) { seen.add(k); items.push(formatItem(r, "movie")); }
  }
  return { success: true, data: items };
}
async function tvSeries() {
  const [pop, top] = await Promise.all([
    tmdb("/tv/popular", { page: "1" }),
    tmdb("/tv/top_rated", { page: "1" }),
  ]);
  const seen = new Set(); const items = [];
  for (const r of [...(pop.results || []), ...(top.results || [])]) {
    const k = String(r.id);
    if (!seen.has(k)) { seen.add(k); items.push(formatItem(r, "tv")); }
  }
  return { success: true, data: items };
}
async function anime() {
  const [top, seasonal] = await Promise.allSettled([
    axios.get("https://api.jikan.moe/v4/top/anime?limit=24&filter=airing", { timeout: 12000 }),
    axios.get("https://api.jikan.moe/v4/seasons/now?limit=24", { timeout: 12000 }),
  ]);
  const topData = top.status === "fulfilled" ? top.value.data?.data || [] : [];
  const seasonalData = seasonal.status === "fulfilled" ? seasonal.value.data?.data || [] : [];
  const seen = new Set(); const items = [];
  for (const r of [...topData, ...seasonalData]) {
    const k = String(r.mal_id);
    if (!seen.has(k)) { seen.add(k); items.push(formatJikanAnime(r)); }
  }
  return { success: true, data: items };
}
async function anilist() {
  const query = `{Page(perPage:24){media(type:ANIME,sort:TRENDING_DESC){id idMal title{romaji english}description coverImage{large}bannerImage averageScore genres startDate{year}}}}`;
  const resp = await axios.post("https://graphql.anilist.co", { query }, {
    headers: { "Content-Type": "application/json" }, timeout: 12000,
  });
  const media = resp.data?.data?.Page?.media || [];
  const items = media.filter((r) => r.title?.english || r.title?.romaji).map(formatAnilistAnime);
  return { success: true, data: items };
}
async function tvmaze() {
  const resp = await axios.get("https://api.tvmaze.com/shows?page=0", { timeout: 10000 });
  const items = (resp.data || []).slice(0, 30).map(formatTVmazeShow);
  return { success: true, data: items };
}
async function search(q) {
  const keyword = (q || "").trim();
  if (!keyword) return { success: true, data: [] };
  const [tmdbRes, jikanRes] = await Promise.allSettled([
    tmdb("/search/multi", { query: keyword, page: "1" }),
    axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(keyword)}&limit=12`, { timeout: 10000 }),
  ]);
  const seen = new Set(); const items = [];
  if (tmdbRes.status === "fulfilled") {
    for (const r of (tmdbRes.value.results || [])) {
      if (r.media_type !== "movie" && r.media_type !== "tv") continue;
      const k = `tmdb-${r.id}`;
      if (!seen.has(k)) { seen.add(k); items.push(formatItem(r)); }
    }
  }
  if (jikanRes.status === "fulfilled") {
    for (const r of (jikanRes.value.data?.data || [])) {
      const k = `jikan-${r.mal_id}`;
      if (!seen.has(k)) { seen.add(k); items.push(formatJikanAnime(r)); }
    }
  }
  return { success: true, data: items };
}
async function detail(id, type) {
  if (!id) return { success: false, error: "Missing id" };
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return { success: false, error: "Invalid id" };
  const isTV = type === "tv";
  const path = isTV ? `/tv/${numId}` : `/movie/${numId}`;
  const data = await tmdb(path, { append_to_response: "external_ids" });
  return { success: true, data: formatItem(data, type) };
}
async function resolveTitle(title, type) {
  if (!title) return { success: false, error: "Missing title" };
  const path = type === "tv" ? "/search/tv" : "/search/movie";
  const data = await tmdb(path, { query: title, page: "1" });
  const first = (data.results || [])[0];
  if (!first) return { success: false, error: "Not found" };
  const forcedType = type === "tv" ? "tv" : "movie";
  return { success: true, data: formatItem(first, forcedType) };
}

// ─── Auth handlers ────────────────────────────────────────────────────────────
async function signup({ email, password, name }) {
  if (!isEmail(email)) return { status: 400, json: { success: false, error: "Invalid email address." } };
  if (!password || String(password).length < 6) return { status: 400, json: { success: false, error: "Password must be at least 6 characters." } };
  await ensureSchema();
  const existing = await db().query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows.length) return { status: 409, json: { success: false, error: "An account with this email already exists." } };
  const hash = await bcrypt.hash(String(password), 10);
  const r = await db().query(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name",
    [email.toLowerCase(), hash, name || null]
  );
  const user = r.rows[0];
  return { status: 200, json: { success: true, token: sign(user), user: { id: user.id, email: user.email, name: user.name } } };
}
async function login({ email, password }) {
  if (!isEmail(email)) return { status: 400, json: { success: false, error: "Invalid email address." } };
  if (!password) return { status: 400, json: { success: false, error: "Password is required." } };
  await ensureSchema();
  const r = await db().query("SELECT id, email, name, password_hash FROM users WHERE email = $1", [email.toLowerCase()]);
  if (!r.rows.length) return { status: 401, json: { success: false, error: "No account found with this email." } };
  const user = r.rows[0];
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return { status: 401, json: { success: false, error: "Incorrect password." } };
  return { status: 200, json: { success: true, token: sign(user), user: { id: user.id, email: user.email, name: user.name } } };
}

// ─── Watchlist handlers ───────────────────────────────────────────────────────
async function watchlistGet(u) {
  await ensureSchema();
  const r = await db().query(
    `SELECT item_id AS id, title, cover, backdrop, tmdb_id AS "tmdbId", type, media_type AS "mediaType",
            genre, release_date AS "releaseDate", imdb_rating AS "imdbRating", description, source
     FROM watchlist WHERE user_id = $1 ORDER BY added_at DESC`,
    [u.id]
  );
  return { success: true, data: r.rows };
}
async function watchlistAdd(u, item) {
  if (!item || !item.id) return { success: false, error: "Missing item" };
  await ensureSchema();
  await db().query(
    `INSERT INTO watchlist (user_id, item_id, title, cover, backdrop, tmdb_id, type, media_type, genre, release_date, imdb_rating, description, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (user_id, item_id) DO NOTHING`,
    [u.id, String(item.id), item.title || "", item.cover || null, item.backdrop || null,
     item.tmdbId ? String(item.tmdbId) : null, item.type || 1, item.mediaType || "movie",
     item.genre || null, item.releaseDate || null, item.imdbRating || null, item.description || null, item.source || "tmdb"]
  );
  return { success: true };
}
async function watchlistDel(u, id) {
  if (!id) return { success: false, error: "Missing id" };
  await ensureSchema();
  await db().query("DELETE FROM watchlist WHERE user_id = $1 AND item_id = $2", [u.id, String(id)]);
  return { success: true };
}

// ─── Watch History handlers ────────────────────────────────────────────────────
async function historyGet(u) {
  await ensureSchema();
  const r = await db().query(
    `SELECT item_id AS id, title, cover, media_type AS "mediaType", tmdb_id AS "tmdbId",
            source, season, episode, progress_pct AS "progressPct", updated_at AS "updatedAt"
     FROM watch_history WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
    [u.id]
  );
  return { success: true, data: r.rows };
}
async function historySave(u, item) {
  if (!item || !item.id) return { success: false, error: "Missing item" };
  await ensureSchema();
  await db().query(
    `INSERT INTO watch_history (user_id, item_id, title, cover, media_type, tmdb_id, source, season, episode, progress_pct, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (user_id, item_id) DO UPDATE SET
       title=EXCLUDED.title, cover=EXCLUDED.cover, season=EXCLUDED.season,
       episode=EXCLUDED.episode, progress_pct=EXCLUDED.progress_pct, updated_at=NOW()`,
    [u.id, String(item.id), item.title || "", item.cover || null,
     item.mediaType || "movie", item.tmdbId ? String(item.tmdbId) : null,
     item.source || "tmdb", item.season || 1, item.episode || 1, item.progressPct || 0]
  );
  return { success: true };
}
async function historyDel(u, id) {
  if (!id) return { success: false, error: "Missing id" };
  await ensureSchema();
  await db().query("DELETE FROM watch_history WHERE user_id = $1 AND item_id = $2", [u.id, String(id)]);
  return { success: true };
}

// ─── Community Chat handlers ──────────────────────────────────────────────────
async function chatGet(sinceId) {
  await ensureSchema();
  const r = await db().query(
    `SELECT id, user_name AS "userName", message, created_at AS "createdAt"
     FROM community_chat ORDER BY created_at DESC LIMIT 60`
  );
  const onlineCount = Math.floor(Math.random() * 8) + 3;
  return { success: true, data: r.rows, online: onlineCount };
}
async function chatPost(u, message) {
  if (!message || !String(message).trim()) return { success: false, error: "Empty message" };
  const text = String(message).trim().slice(0, 300);
  await ensureSchema();
  await db().query(
    "INSERT INTO community_chat (user_id, user_name, message) VALUES ($1, $2, $3)",
    [u.id, u.name || u.email.split("@")[0], text]
  );
  return { success: true };
}

// ─── AI chat ─────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are StreamX AI, a friendly movie and TV recommendation assistant.
You help users find movies, TV series, and anime to watch. Keep replies concise (2-4 sentences or a short list).
When recommending, give title + one-line reason. Do not use markdown headers. Be conversational and warm.`;

async function aiChat(messages) {
  const safe = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 4000) }));

  if (process.env.GEMINI_API_KEY) {
    const key = process.env.GEMINI_API_KEY;
    const model = "gemini-2.5-flash";
    const contents = safe.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const payload = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
    };
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      payload,
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    const reply = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || "I'm not sure how to answer that.";
    return { success: true, reply };
  }

  if (process.env.GROQ_API_KEY) {
    const payload = {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...safe],
      max_tokens: 600, temperature: 0.7,
    };
    const r = await axios.post("https://api.groq.com/openai/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      timeout: 30000,
    });
    const reply = r.data?.choices?.[0]?.message?.content || "I'm not sure how to answer that.";
    return { success: true, reply };
  }

  throw new Error("AI is not available right now. Please try again later.");
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const requestOrigin = req.headers["origin"] || "";
  const host = req.headers["host"] || "";
  let allowedOrigin = "";
  if (requestOrigin) {
    try {
      const originHost = new URL(requestOrigin).host;
      if (originHost === host || /^localhost(:\d+)?$/.test(originHost)) {
        allowedOrigin = requestOrigin;
      }
    } catch { /* malformed */ }
  }
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  const _ua   = req.headers["user-agent"] || "";
  const _sub0 = (req.url || "").replace(/^\/api\/?/, "").split("?")[0].toLowerCase();
  const _authExempt = _sub0 === "health" || _sub0.startsWith("auth/");
  if (isBot(_ua)) return rickRoll(req, res);
  if (!_authExempt && !hasValidOrigin(req)) return rickRoll(req, res);

  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname; }
  catch { pathname = req.url || "/"; }
  const sub = pathname.replace(/^\/api\/?/, "").split("?")[0].replace(/\/+$/, "").toLowerCase() || "health";
  const q = getQuery(req);

  try {
    if (sub === "auth/signup") {
      if (req.method !== "POST") return send(res, 405, { success: false, error: "POST only" });
      const body = await readBody(req);
      const r = await signup(body);
      return send(res, r.status, r.json);
    }
    if (sub === "auth/login") {
      if (req.method !== "POST") return send(res, 405, { success: false, error: "POST only" });
      const body = await readBody(req);
      const r = await login(body);
      return send(res, r.status, r.json);
    }
    if (sub === "auth/me") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { success: false, error: "Not signed in" });
      return send(res, 200, { success: true, user: u });
    }
    if (sub === "health")    return send(res, 200, { ok: true });
    if (sub === "trending")  return send(res, 200, await trending());
    if (sub === "list")      return send(res, 200, await list());
    if (sub === "tv-series") return send(res, 200, await tvSeries());
    if (sub === "anime")     return send(res, 200, await anime());
    if (sub === "anilist")   return send(res, 200, await anilist());
    if (sub === "tvmaze")    return send(res, 200, await tvmaze());
    if (sub === "search")    return send(res, 200, await search(q.q));
    if (sub === "detail")    return send(res, 200, await detail(q.id || q.slug, q.type || "movie"));
    if (sub === "resolve")   return send(res, 200, await resolveTitle(q.title, q.type || "tv"));

    if (sub === "watchlist") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { success: false, error: "Sign in required" });
      if (req.method === "GET")    return send(res, 200, await watchlistGet(u));
      if (req.method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await watchlistAdd(u, body.item));
      }
      if (req.method === "DELETE") {
        const body = await readBody(req);
        return send(res, 200, await watchlistDel(u, body.id));
      }
      return send(res, 405, { success: false, error: "Method not allowed" });
    }

    if (sub === "ai/chat") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { success: false, error: "Sign in required" });
      if (req.method !== "POST") return send(res, 405, { success: false, error: "POST only" });
      const body = await readBody(req);
      return send(res, 200, await aiChat(body.messages || []));
    }

    if (sub === "history") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { success: false, error: "Sign in required" });
      if (req.method === "GET")    return send(res, 200, await historyGet(u));
      if (req.method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await historySave(u, body.item));
      }
      if (req.method === "DELETE") {
        const body = await readBody(req);
        return send(res, 200, await historyDel(u, body.id));
      }
      return send(res, 405, { success: false, error: "Method not allowed" });
    }

    if (sub === "chat") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { success: false, error: "Sign in required" });
      if (req.method === "GET") {
        const since = q.since ? Number(q.since) : null;
        return send(res, 200, await chatGet(since));
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await chatPost(u, body.message));
      }
      return send(res, 405, { success: false, error: "Method not allowed" });
    }

    const adminKey = process.env.ADMIN_KEY || "Berwin290@";
    if (sub === "admin/users") {
      const key = req.headers["x-admin-key"] || getQuery(req).key;
      if (key !== adminKey) return send(res, 403, { success: false, error: "Unauthorized" });
      if (req.method !== "GET") return send(res, 405, { success: false, error: "GET only" });
      await ensureSchema();
      const r = await db().query(`
        SELECT u.id, u.email, u.name, u.password_hash, u.created_at,
          (SELECT COUNT(*) FROM watchlist WHERE user_id = u.id) AS watchlist_count,
          (SELECT COUNT(*) FROM watch_history WHERE user_id = u.id) AS history_count
        FROM users u ORDER BY u.created_at DESC LIMIT 1000`);
      return send(res, 200, { success: true, data: r.rows });
    }
    if (sub === "admin/users/delete") {
      const key = req.headers["x-admin-key"] || getQuery(req).key;
      if (key !== adminKey) return send(res, 403, { success: false, error: "Unauthorized" });
      if (req.method !== "DELETE") return send(res, 405, { success: false, error: "DELETE only" });
      const body = await readBody(req);
      if (!body.id) return send(res, 400, { success: false, error: "Missing user id" });
      await ensureSchema();
      await db().query(`DELETE FROM users WHERE id = $1`, [body.id]);
      await db().query(`DELETE FROM watchlist WHERE user_id = $1`, [body.id]);
      return send(res, 200, { success: true });
    }

    return send(res, 404, { success: false, error: `Unknown route: ${sub}` });
  } catch (e) {
    return send(res, 500, { success: false, error: e.message || "Server error" });
  }
};
