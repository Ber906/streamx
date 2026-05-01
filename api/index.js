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
// AI (auth required):
//   POST /api/ai/chat       { messages: [{ role, content }] }

const axios = require("axios");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

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
      user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id     TEXT NOT NULL,
      title       TEXT NOT NULL,
      cover       TEXT,
      backdrop    TEXT,
      tmdb_id     TEXT,
      type        INTEGER DEFAULT 1,
      media_type  TEXT,
      genre       TEXT,
      release_date TEXT,
      imdb_rating  TEXT,
      description  TEXT,
      source      TEXT,
      added_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS watchlist_user_added_idx ON watchlist (user_id, added_at DESC);
  `);
  schemaReady = true;
}

// ─── Auth helpers ────────────────────────────────────────────────────────────
// JWT secret is auto-derived from DATABASE_URL so no separate env var is needed.
// If JWT_SECRET is explicitly set it takes priority.
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
  return {
    id: String(raw.id), tmdbId: raw.id, mediaType,
    title: raw.title || raw.name || "Unknown",
    description: raw.overview || "",
    releaseDate: raw.release_date || raw.first_air_date || null,
    duration: raw.runtime || (raw.episode_run_time && raw.episode_run_time[0]) || null,
    genre, cover, backdrop, country,
    imdbRating: raw.vote_average ? raw.vote_average.toFixed(1) : null,
    type: isTV ? 2 : 1, seasons, source: "tmdb",
  };
}
function formatJikanAnime(raw) {
  return {
    id: `jikan-${raw.mal_id}`, tmdbId: null, mediaType: "tv",
    title: raw.title_english || raw.title,
    description: (raw.synopsis || "").replace(/\[Written by.*?\]/gi, "").trim(),
    releaseDate: raw.year ? `${raw.year}-01-01` : null,
    genre: (raw.genres || []).map((g) => g.name).join(", ") || null,
    cover: raw.images?.jpg?.large_image_url || null, backdrop: null,
    country: "Japan",
    imdbRating: raw.score ? raw.score.toFixed(1) : null,
    type: 2, seasons: [], source: "jikan",
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
  const query = `{Page(perPage:24){media(type:ANIME,sort:TRENDING_DESC){id title{romaji english}description coverImage{large}averageScore genres startDate{year}}}}`;
  const resp = await axios.post("https://graphql.anilist.co", { query }, {
    headers: { "Content-Type": "application/json" }, timeout: 12000,
  });
  const media = resp.data?.data?.Page?.media || [];
  const items = media.filter((r) => r.title?.english || r.title?.romaji).map((r) => ({
    id: `anilist-${r.id}`, tmdbId: null, mediaType: "tv",
    title: r.title?.english || r.title?.romaji,
    description: (r.description || "").replace(/<[^>]*>/g, ""),
    releaseDate: r.startDate?.year ? `${r.startDate.year}-01-01` : null,
    genre: (r.genres || []).join(", ") || null,
    cover: r.coverImage?.large || null, backdrop: null, country: "Japan",
    imdbRating: r.averageScore ? (r.averageScore / 10).toFixed(1) : null,
    type: 2, seasons: [], source: "anilist",
  }));
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
  const [tmdbRes, jikanRes, tvmazeRes] = await Promise.allSettled([
    tmdb("/search/multi", { query: keyword, page: "1" }),
    axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(keyword)}&limit=5`, { timeout: 8000 }),
    axios.get(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(keyword)}`, { timeout: 8000 }),
  ]);
  const items = []; const seen = new Set();
  if (tmdbRes.status === "fulfilled") {
    for (const r of tmdbRes.value.results || []) {
      if (r.media_type === "movie" || r.media_type === "tv") {
        items.push(formatItem(r));
        seen.add((r.title || r.name || "").toLowerCase());
      }
    }
  }
  if (jikanRes.status === "fulfilled") {
    for (const r of jikanRes.value.data?.data || []) {
      const t = (r.title_english || r.title || "").toLowerCase();
      if (t && !seen.has(t)) { seen.add(t); items.push(formatJikanAnime(r)); }
    }
  }
  if (tvmazeRes.status === "fulfilled") {
    for (const r of tvmazeRes.value.data || []) {
      const t = (r.show?.name || "").toLowerCase();
      if (t && !seen.has(t)) { seen.add(t); items.push(formatTVmazeShow(r)); }
    }
  }
  return { success: true, data: items, keyword };
}
async function detail(id, type) {
  if (!id) throw new Error("Missing id");
  const path = type === "tv" ? `/tv/${id}` : `/movie/${id}`;
  const data = await tmdb(path, { append_to_response: "credits,seasons" });
  return { success: true, data: formatItem(data, type === "tv" ? "tv" : "movie") };
}
async function resolveTitle(title, type) {
  if (!title) throw new Error("Missing title");
  const t = type === "movie" ? "movie" : "tv";
  const searchPath = t === "movie" ? "/search/movie" : "/search/tv";
  const data = await tmdb(searchPath, { query: title, page: 1 });
  const result = data.results?.[0];
  if (!result) return { success: false, error: "Not found on TMDB" };
  const detailPath = t === "movie" ? `/movie/${result.id}` : `/tv/${result.id}`;
  const det = await tmdb(detailPath, { append_to_response: "credits,seasons" });
  return { success: true, data: formatItem(det, t) };
}

// ─── Auth handlers ───────────────────────────────────────────────────────────
async function signup(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim() || email.split("@")[0];
  if (!isEmail(email)) return { status: 400, json: { success: false, error: "Please enter a valid email." } };
  if (password.length < 6) return { status: 400, json: { success: false, error: "Password must be at least 6 characters." } };
  await ensureSchema();
  const exists = await db().query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (exists.rows.length) return { status: 409, json: { success: false, error: "An account with this email already exists." } };
  const hash = await bcrypt.hash(password, 10);
  const r = await db().query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name`,
    [email, hash, name]
  );
  const user = r.rows[0];
  return { status: 200, json: { success: true, token: sign(user), user } };
}
async function login(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return { status: 400, json: { success: false, error: "Email and password are required." } };
  await ensureSchema();
  const r = await db().query(`SELECT id, email, name, password_hash FROM users WHERE email = $1`, [email]);
  const u = r.rows[0];
  if (!u) return { status: 401, json: { success: false, error: "Wrong email or password." } };
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return { status: 401, json: { success: false, error: "Wrong email or password." } };
  const safe = { id: u.id, email: u.email, name: u.name };
  return { status: 200, json: { success: true, token: sign(safe), user: safe } };
}

// ─── Watchlist ───────────────────────────────────────────────────────────────
function rowToItem(r) {
  return {
    id: r.item_id, tmdbId: r.tmdb_id ? Number(r.tmdb_id) : null,
    title: r.title, cover: r.cover, backdrop: r.backdrop,
    type: r.type, mediaType: r.media_type, genre: r.genre,
    releaseDate: r.release_date, imdbRating: r.imdb_rating,
    description: r.description, source: r.source, seasons: [],
  };
}
async function watchlistGet(user) {
  await ensureSchema();
  const r = await db().query(
    `SELECT * FROM watchlist WHERE user_id = $1 ORDER BY added_at DESC LIMIT 200`, [user.id]
  );
  return { success: true, data: r.rows.map(rowToItem) };
}
async function watchlistAdd(user, item) {
  if (!item || !item.id) throw new Error("Missing item");
  await ensureSchema();
  await db().query(
    `INSERT INTO watchlist (user_id,item_id,title,cover,backdrop,tmdb_id,type,media_type,genre,release_date,imdb_rating,description,source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id,item_id) DO UPDATE SET added_at = NOW()`,
    [
      user.id, String(item.id), item.title || "Untitled",
      item.cover || null, item.backdrop || null,
      item.tmdbId != null ? String(item.tmdbId) : null,
      item.type || 1, item.mediaType || null, item.genre || null,
      item.releaseDate || null, item.imdbRating || null,
      item.description || null, item.source || null,
    ]
  );
  return { success: true };
}
async function watchlistDel(user, id) {
  if (!id) throw new Error("Missing id");
  await ensureSchema();
  await db().query(`DELETE FROM watchlist WHERE user_id = $1 AND item_id = $2`, [user.id, String(id)]);
  return { success: true };
}

// ─── AI chat ─────────────────────────────────────────────────────────────────
// GEMINI (recommended — free, no CC, just a Google account):
//   Get key at https://aistudio.google.com/app/apikey  (free, no credit card)
//   Set GEMINI_API_KEY in Vercel env vars.
//   Uses native Gemini REST API (gemini-2.5-flash).
//
// GROQ (backup):
//   Get key at https://console.groq.com
//   Set GROQ_API_KEY in Vercel env vars.

const SYSTEM_PROMPT = `You are StreamX AI, a friendly assistant inside a movie / TV / anime streaming site called StreamX.
Help users discover what to watch. Be warm, concise, and specific. When recommending titles:
- prefer popular, well-known titles available on most catalogs (TMDB / MyAnimeList).
- give short reasons (one sentence each).
- when listing titles, use a short bullet list with the year in parens.
Keep replies under ~180 words unless the user asks for more.`;

async function aiChat(messages) {
  const safe = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-12)
    .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 4000) }));

  // ── Gemini native REST API ──────────────────────────────────────────────────
  if (process.env.GEMINI_API_KEY) {
    const key = process.env.GEMINI_API_KEY;
    const model = "gemini-2.5-flash";
    // Gemini uses "model" for assistant, "user" for user
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
    const reply = r.data?.candidates?.[0]?.content?.parts?.[0]?.text
      || "I'm not sure how to answer that.";
    return { success: true, reply };
  }

  // ── Groq / OpenAI-compat fallback ──────────────────────────────────────────
  if (process.env.GROQ_API_KEY) {
    const payload = {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...safe.map(m => ({ role: m.role, content: m.content }))],
      max_tokens: 600,
      temperature: 0.7,
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  let pathname;
  try { pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname; }
  catch { pathname = req.url || "/"; }
  const sub = pathname.replace(/^\/api\/?/, "").split("?")[0].replace(/\/+$/, "").toLowerCase() || "health";
  const q = getQuery(req);

  try {
    // ─── Auth ────────
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

    // ─── Catalog ────────
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

    // ─── Watchlist (auth required) ────────
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

    // ─── AI chat (auth required) ────────
    if (sub === "ai/chat") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { success: false, error: "Sign in required" });
      if (req.method !== "POST") return send(res, 405, { success: false, error: "POST only" });
      const body = await readBody(req);
      return send(res, 200, await aiChat(body.messages || []));
    }

    return send(res, 404, { success: false, error: `Unknown route: ${sub}` });
  } catch (e) {
    return send(res, 500, { success: false, error: e.message || "Server error" });
  }
};
