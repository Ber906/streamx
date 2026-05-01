# StreamX

A single-page streaming site (movies, series, anime) with login/signup, an AI assistant powered by **Google Gemini** (free, no credit card), 12 embed servers, a Postgres-backed watchlist, and a one-click Vercel deploy.

```
streamx/
├── index.html        # The whole frontend (auth, UI, AI chat, coffee popup)
├── api/
│   └── index.js      # The whole backend (auth, catalog, watchlist, AI)
├── schema.sql        # Database schema (users + watchlist)
├── vercel.json       # Routes /api/* to the serverless function
├── package.json      # Backend dependencies
├── dev-server.js     # Local dev server (simulates Vercel)
├── .env.example      # The env vars you need
└── README.md
```

## What's inside

- **Login / sign up** — email + password, stored in Postgres with bcrypt + JWT.
- **12 streaming servers** — vidlink, vidsrc.cc, vidsrc.xyz, embed.su, vidsrc.to, 2embed, multiembed, moviesapi, autoembed, 111movies, madplay, smashy. Switch if one is slow.
- **AI assistant (Gemini 1.5 Flash)** — 100% free, no credit card. Chat button (✨) on bottom-right.
- **Watchlist** — saved to your account, not the browser.
- **Coffee popup** — GCash 09918369012 for Berwin.
- **Catalog** — TMDB (movies + TV), MyAnimeList (Jikan), AniList, TVmaze.

## Required setup — only 2 env vars

| Name | What it is |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (free at neon.tech) |
| `GEMINI_API_KEY` | Google Gemini AI key (free at aistudio.google.com/app/apikey) |

No JWT_SECRET needed — the app derives it automatically from your DATABASE_URL.

---

## Deploy to Vercel — step by step

### 1. Create a free Neon database

1. Go to **https://neon.tech** → Sign up (free).
2. Create a project. Copy the **connection string**:
   ```
   postgresql://neondb_owner:••••@xxxx.neon.tech/neondb?sslmode=require
   ```
3. *(Optional)* Paste `schema.sql` into Neon's SQL Editor and run it. Tables are also created automatically on first use.

### 2. Get a free Google Gemini API key

1. Go to **https://aistudio.google.com/app/apikey**
2. Sign in with your Google account (no credit card needed).
3. Click **Create API Key**.
4. Copy it — it starts with `AIza...`.

That's it. Free tier gives you **1 million tokens per day** — more than enough.

> **Backup option:** If Gemini is unavailable, you can use Groq instead.
> Get a free key at https://console.groq.com and set `GROQ_API_KEY` instead of `GEMINI_API_KEY`.

### 3. Push to GitHub

```bash
cd streamx
git init
git add .
git commit -m "init StreamX"
git branch -M main
git remote add origin https://github.com/<your-username>/streamx.git
git push -u origin main
```

### 4. Import on Vercel

1. Go to **https://vercel.com/new** → pick your `streamx` repo.
2. **Framework preset**: Other.
3. **Build command** and **Output directory**: leave blank.
4. Add these 2 environment variables:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | your Neon connection string |
   | `GEMINI_API_KEY` | your Gemini key (`AIza...`) |

5. Click **Deploy**.

Done — live at `https://<your-project>.vercel.app`.

### 5. (Optional) Custom domain

Vercel project → **Settings → Domains** → add your domain. SSL is automatic.

---

## Run locally

```bash
cd streamx
cp .env.example .env      # fill in DATABASE_URL and GEMINI_API_KEY
npm install
npm run dev
# open http://localhost:5000
```

---

## API routes

| Method | Path | Auth | What it does |
|--------|------|------|-------------|
| POST | `/api/auth/signup` | — | `{ email, password, name? }` |
| POST | `/api/auth/login` | — | `{ email, password }` → token |
| GET | `/api/auth/me` | yes | Current user |
| GET | `/api/trending` | — | TMDB trending |
| GET | `/api/list` | — | TMDB popular movies |
| GET | `/api/tv-series` | — | TMDB popular TV |
| GET | `/api/anime` | — | Jikan top anime |
| GET | `/api/anilist` | — | AniList trending anime |
| GET | `/api/tvmaze` | — | TVmaze shows |
| GET | `/api/search?q=…` | — | Multi-source search |
| GET | `/api/detail?id&type` | — | TMDB detail (seasons included) |
| GET | `/api/resolve?title&type` | — | Find TMDB id for a non-TMDB title |
| GET | `/api/watchlist` | yes | Saved titles |
| POST | `/api/watchlist` | yes | `{ item }` — save a title |
| DELETE | `/api/watchlist` | yes | `{ id }` — remove a title |
| POST | `/api/ai/chat` | yes | `{ messages: [{role, content}] }` |

## Notes

- AI uses **Gemini 1.5 Flash** via Google's free tier (1M tokens/day). Falls back to Groq if `GROQ_API_KEY` is set instead.
- Streaming sources are third-party embed players — no video is hosted here.
- Passwords are stored hashed with bcrypt. JWT tokens last 30 days.
- Credit: original concept by Berwin Villareal — https://github.com/Ber906/cinestream
