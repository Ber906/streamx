-- StreamX PostgreSQL schema
-- Run this manually on a fresh database, or let the server auto-create via ensureSchema()

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  cover         TEXT,
  backdrop      TEXT,
  tmdb_id       TEXT,
  type          INTEGER DEFAULT 1,
  media_type    TEXT,
  genre         TEXT,
  release_date  TEXT,
  imdb_rating   TEXT,
  description   TEXT,
  source        TEXT,
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS watchlist_user_added_idx ON watchlist (user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS watch_history (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  cover         TEXT,
  media_type    TEXT,
  tmdb_id       TEXT,
  source        TEXT,
  season        INTEGER DEFAULT 1,
  episode       INTEGER DEFAULT 1,
  progress_pct  INTEGER DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS watch_history_user_idx ON watch_history (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS community_chat (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name   TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comm_chat_created_idx ON community_chat (created_at DESC);
