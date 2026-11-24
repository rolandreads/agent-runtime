CREATE TABLE settings_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  replaced_at INTEGER
);
INSERT INTO settings_versions (key, value, created_at, replaced_at)
SELECT key, value, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL FROM settings;
DROP TABLE settings;
ALTER TABLE settings_versions RENAME TO settings;
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_current ON settings(key) WHERE replaced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_settings_key_created ON settings(key, created_at);
