CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id    TEXT,
  event_type  TEXT NOT NULL,
  duration_ms INTEGER,
  user_id     TEXT REFERENCES users(id),
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
CREATE INDEX IF NOT EXISTS idx_events_type_created_at ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

CREATE TABLE IF NOT EXISTS costs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  trace_id   TEXT,
  user_id    TEXT REFERENCES users(id),
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_trace ON costs(trace_id);
CREATE INDEX IF NOT EXISTS idx_costs_created_at ON costs(created_at);

CREATE TABLE IF NOT EXISTS provider_machine_blacklist (
  provider            TEXT NOT NULL,
  provider_machine_id TEXT NOT NULL,
  offer_id            TEXT,
  reason              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, provider_machine_id)
);

CREATE TABLE IF NOT EXISTS compute_workers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  provider             TEXT NOT NULL,
  provider_worker_id   TEXT NOT NULL,
  provider_machine_id  TEXT,
  image_reference      TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  destroyed_at         INTEGER
);

CREATE TABLE IF NOT EXISTS compute_worker_assets (
  compute_worker_id INTEGER NOT NULL REFERENCES compute_workers(id) ON DELETE CASCADE,
  asset_fingerprint TEXT NOT NULL,
  synced_at         INTEGER NOT NULL,
  PRIMARY KEY (compute_worker_id, asset_fingerprint)
);

CREATE TABLE IF NOT EXISTS discord_gateway_sessions (
  character_id TEXT NOT NULL,
  shard_id     INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  resume_url   TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  shard_count  INTEGER NOT NULL,
  PRIMARY KEY (character_id, shard_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id),
  character_id TEXT NOT NULL,
  scope_key    TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_character ON conversations(user_id, character_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_turns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id),
  trace_id            TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  failure             TEXT,
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_conversation_created ON agent_turns(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_one_running_per_conversation ON agent_turns(conversation_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS agent_messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    INTEGER NOT NULL REFERENCES conversations(id),
  turn_id            INTEGER NOT NULL REFERENCES agent_turns(id),
  role               TEXT NOT NULL,
  agent_message_json TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation_id ON agent_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_turn ON agent_messages(turn_id);

CREATE TABLE IF NOT EXISTS frontend_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id),
  agent_message_id    INTEGER REFERENCES agent_messages(id),
  generated_image_id  INTEGER REFERENCES generated_images(id),
  frontend            TEXT NOT NULL,
  frontend_message_id TEXT NOT NULL,
  frontend_channel_id TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  chunk_index         INTEGER NOT NULL,
  content_json        TEXT,
  created_at          INTEGER NOT NULL,
  UNIQUE (frontend, frontend_message_id)
);
CREATE INDEX IF NOT EXISTS idx_frontend_messages_conversation_created ON frontend_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_frontend_messages_agent_message ON frontend_messages(agent_message_id);
CREATE INDEX IF NOT EXISTS idx_frontend_messages_generated_image ON frontend_messages(generated_image_id);

CREATE TABLE IF NOT EXISTS agent_turn_inputs (
  turn_id             INTEGER NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  frontend_message_id INTEGER NOT NULL REFERENCES frontend_messages(id),
  position            INTEGER NOT NULL,
  PRIMARY KEY (turn_id, position)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turn_inputs_frontend_message ON agent_turn_inputs(frontend_message_id);

CREATE TABLE IF NOT EXISTS user_personalizations (
  user_id             TEXT NOT NULL REFERENCES users(id),
  character_id        TEXT NOT NULL,
  notes               TEXT NOT NULL,
  auto_lora_selection INTEGER NOT NULL CHECK (auto_lora_selection IN (0, 1)),
  detail_pass_enabled    INTEGER NOT NULL CHECK (detail_pass_enabled IN (0, 1)),
  pinned_loras        TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE IF NOT EXISTS image_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_image_id  INTEGER REFERENCES generated_images(id),
  trace_id         TEXT NOT NULL,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
  character_id     TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id),
  generation_spec  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'delivered', 'failed')),
  failure          TEXT CHECK (failure IN ('expired', 'generation_failed', 'delivery_failed')),
  capacity_path    TEXT NOT NULL DEFAULT 'cold' CHECK (capacity_path IN ('warm', 'cold')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (
    (status = 'failed' AND failure IS NOT NULL)
    OR (status IN ('queued', 'processing', 'delivered') AND failure IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_imgreq_status_created_at ON image_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_imgreq_trace ON image_requests(trace_id);
CREATE INDEX IF NOT EXISTS idx_imgreq_created_at ON image_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_imgreq_source_image ON image_requests(source_image_id);

CREATE TABLE IF NOT EXISTS generated_images (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  image_request_id  INTEGER NOT NULL REFERENCES image_requests(id),
  file_size_bytes   INTEGER NOT NULL,
  r2_key            TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genimg_request ON generated_images(image_request_id);

CREATE TABLE IF NOT EXISTS animate_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_image_id  INTEGER NOT NULL REFERENCES generated_images(id),
  trace_id         TEXT NOT NULL,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
  character_id     TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id),
  prompt           TEXT NOT NULL,
  grok_request_id  TEXT,
  r2_key           TEXT NOT NULL,
  file_size_bytes  INTEGER,
  cost_usd         REAL,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'delivered', 'failed')),
  failure          TEXT CHECK (failure IN ('generation_failed', 'delivery_failed', 'refused')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (
    (status = 'failed' AND failure IS NOT NULL)
    OR (status IN ('queued', 'processing', 'delivered') AND failure IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_animreq_status_created_at ON animate_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_animreq_trace ON animate_requests(trace_id);
CREATE INDEX IF NOT EXISTS idx_animreq_source_image ON animate_requests(source_image_id);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT NOT NULL PRIMARY KEY,
  created_at INTEGER NOT NULL,
  access     TEXT NOT NULL DEFAULT 'admitted' CHECK (access IN ('admitted', 'revoked'))
);

CREATE TABLE IF NOT EXISTS user_identities (
  user_id          TEXT NOT NULL REFERENCES users(id),
  platform         TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  replaced_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_current ON settings(key) WHERE replaced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_settings_key_created ON settings(key, created_at);
