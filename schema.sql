-- StreamX — database schema
-- Auto-created by the backend on first call. You can also run this manually.

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
  type         INTEGER DEFAULT 1,        -- 1 = movie, 2 = series
  media_type   TEXT,                     -- 'movie' | 'tv'
  genre        TEXT,
  release_date TEXT,
  imdb_rating  TEXT,
  description  TEXT,
  source       TEXT,                     -- 'tmdb' | 'jikan' | 'anilist' | 'tvmaze'
  added_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS watchlist_user_added_idx
  ON watchlist (user_id, added_at DESC);
