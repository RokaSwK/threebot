-- One row per install per UTC day. The primary key is the rate limit: a second ping that day is ignored.
-- No IP address, user agent or other request data is stored.
CREATE TABLE IF NOT EXISTS pings (
  day TEXT NOT NULL,              -- UTC day the ping arrived, YYYY-MM-DD
  install_id TEXT NOT NULL,       -- random UUID made by the install, resettable by the user
  threebot TEXT NOT NULL,
  t3code TEXT,
  node TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  bots TEXT NOT NULL,             -- bucket: 0, 1, 2-5, 6-10, 11+
  routines TEXT,                  -- bucket, or NULL when T3 Code didn't answer
  projects INTEGER NOT NULL,
  auto_update INTEGER NOT NULL,
  fresh_session_routines INTEGER NOT NULL,
  PRIMARY KEY (day, install_id)
);
-- Token usage since the install's previous ping, per model.
CREATE TABLE IF NOT EXISTS tokens (
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  model TEXT NOT NULL,
  turns INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,          -- includes cache reads and writes
  cached_input_tokens INTEGER NOT NULL,   -- cache reads
  cache_creation_tokens INTEGER NOT NULL, -- cache writes
  output_tokens INTEGER NOT NULL,         -- includes reasoning
  PRIMARY KEY (day, install_id, model)
);
CREATE INDEX IF NOT EXISTS tokens_day_model ON tokens (day, model);
