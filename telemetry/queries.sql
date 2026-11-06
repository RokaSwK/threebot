-- Dashboard queries. Run with: npx wrangler d1 execute threebot-telemetry --remote --command "<query>"
-- (or GET /v1/stats?days=30 with the STATS_TOKEN bearer).

-- Active installs per day
SELECT day, COUNT(*) AS installs FROM pings GROUP BY day ORDER BY day DESC LIMIT 30;

-- Active installs in the last 7 and 30 days
SELECT
  (SELECT COUNT(DISTINCT install_id) FROM pings WHERE day >= date('now', '-6 days')) AS last_7_days,
  (SELECT COUNT(DISTINCT install_id) FROM pings WHERE day >= date('now', '-29 days')) AS last_30_days;

-- Installs by Threebot version (latest day)
SELECT threebot, COUNT(*) AS installs FROM pings WHERE day = (SELECT MAX(day) FROM pings) GROUP BY threebot ORDER BY installs DESC;

-- Installs by T3 Code version, OS and arch (last 7 days, each install once)
SELECT t3code, os, arch, COUNT(DISTINCT install_id) AS installs FROM pings WHERE day >= date('now', '-6 days') GROUP BY t3code, os, arch ORDER BY installs DESC;

-- Tokens by model per day
SELECT day, model, SUM(turns) AS turns, SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cache_read,
  SUM(cache_creation_tokens) AS cache_write, SUM(output_tokens) AS output, COUNT(*) AS installs
FROM tokens GROUP BY day, model ORDER BY day DESC, output DESC;

-- Feature adoption (last 7 days, each install's latest ping)
SELECT AVG(projects) AS projects, AVG(auto_update) AS auto_update, AVG(fresh_session_routines) AS fresh_session_routines, COUNT(*) AS installs
FROM pings p WHERE day = (SELECT MAX(day) FROM pings q WHERE q.install_id = p.install_id) AND day >= date('now', '-6 days');

-- Bots and routines buckets (last 7 days, latest ping per install)
SELECT bots, routines, COUNT(*) AS installs FROM pings p WHERE day = (SELECT MAX(day) FROM pings q WHERE q.install_id = p.install_id) AND day >= date('now', '-6 days') GROUP BY bots, routines;

-- Retention: drop pings older than 400 days
DELETE FROM pings WHERE day < date('now', '-400 days');
DELETE FROM tokens WHERE day < date('now', '-400 days');
