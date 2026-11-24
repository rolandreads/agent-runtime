export type AgentMessagesRow = {
  id: number;
  role: string;
  turn_id: number;
  created_at: number;
  conversation_id: number;
  agent_message_json: string;
};

export type AgentTurnInputsRow = {
  turn_id: number;
  position: number;
  frontend_message_id: number;
};

export type AgentTurnsRow = {
  id: number;
  status: string;
  trace_id: string;
  created_at: number;
  failure: string | null;
  conversation_id: number;
  completed_at: number | null;
};

export type AnimateRequestsRow = {
  id: number;
  prompt: string;
  r2_key: string;
  status: string;
  user_id: string;
  trace_id: string;
  created_at: number;
  updated_at: number;
  character_id: string;
  failure: string | null;
  conversation_id: number;
  cost_usd: number | null;
  source_image_id: number;
  file_size_bytes: number | null;
  grok_request_id: string | null;
};

export type ComputeWorkerAssetsRow = {
  synced_at: number;
  asset_fingerprint: string;
  compute_worker_id: number;
};

export type ComputeWorkersRow = {
  id: number;
  provider: string;
  created_at: number;
  image_reference: string;
  provider_worker_id: string;
  destroyed_at: number | null;
  provider_machine_id: string | null;
};

export type ConversationsRow = {
  id: number;
  user_id: string;
  scope_key: string;
  created_at: number;
  updated_at: number;
  character_id: string;
};

export type CostsRow = {
  id: number;
  data: string;
  source: string;
  amount_usd: number;
  created_at: number;
  user_id: string | null;
  trace_id: string | null;
};

export type DiscordGatewaySessionsRow = {
  sequence: number;
  shard_id: number;
  resume_url: string;
  session_id: string;
  shard_count: number;
  character_id: string;
};

export type EventsRow = {
  id: number;
  data: string;
  created_at: number;
  event_type: string;
  user_id: string | null;
  trace_id: string | null;
  duration_ms: number | null;
};

export type FrontendMessagesRow = {
  id: number;
  frontend: string;
  direction: string;
  created_at: number;
  chunk_index: number;
  conversation_id: number;
  content_json: string | null;
  frontend_channel_id: string;
  frontend_message_id: string;
  agent_message_id: number | null;
  generated_image_id: number | null;
};

export type GeneratedImagesRow = {
  id: number;
  created_at: number;
  r2_key: string | null;
  file_size_bytes: number;
  image_request_id: number;
};

export type ImageRequestsRow = {
  id: number;
  status: string;
  user_id: string;
  trace_id: string;
  created_at: number;
  updated_at: number;
  character_id: string;
  capacity_path: string;
  failure: string | null;
  conversation_id: number;
  generation_spec: string;
  source_image_id: number | null;
};

export type ProviderMachineBlacklistRow = {
  reason: string;
  provider: string;
  created_at: number;
  expires_at: number;
  offer_id: string | null;
  provider_machine_id: string;
};

export type SettingsRow = {
  id: number;
  key: string;
  value: string;
  created_at: number;
  replaced_at: number | null;
};

export type UserIdentitiesRow = {
  user_id: string;
  platform: string;
  created_at: number;
  platform_user_id: string;
};

export type UserPersonalizationsRow = {
  notes: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  character_id: string;
  pinned_loras: string;
  auto_lora_selection: number;
  detail_pass_enabled: number;
};

export type UsersRow = {
  id: string;
  access: string;
  created_at: number;
};
