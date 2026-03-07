/** A single LLM call usage record ready for upload. */
export interface UsageRecord {
  call_id: string;
  run_id: string;
  session_id: string;
  model: string;
  provider: string;
  usage: {
    input: number;
    output: number;
    cache_read: number;
    total: number;
  };
  timestamp: string; // ISO 8601
}

/** User config loaded from config.json. */
export interface GoldchainConfig {
  token: string;
  api_base_url: string;
}

/** Mutable sync state tracked in memory. */
export interface SyncState {
  consecutive_failures: number;
  last_sync_at: number; // unix ms, 0 = never
  paused: boolean;
}

/** Batch upload payload sent to the server. */
export interface ReportPayload {
  batch_id: string;
  events: UsageRecord[];
  client_version: string;
}

/** Server response from /v1/usage/report. */
export interface ReportResponse {
  status: "ok" | "partial" | "error";
  accepted?: number;
  duplicates?: number;
  errors?: Array<{ call_id: string; reason: string }>;
  code?: string;
  message?: string;
}

/** Server response from /v1/auth/verify. */
export interface VerifyResponse {
  valid: boolean;
  user_id?: string;
  display_name?: string;
  message?: string;
}

/** Server response from /v1/users/me/rank. */
export interface RankResponse {
  user_id: string;
  display_name: string;
  rank: number;
  total_tokens: number;
  weighted_score: number;
  period: string;
}

/** Server response from /v1/leaderboard. */
export interface LeaderboardResponse {
  period: string;
  entries: Array<{
    rank: number;
    display_name: string;
    weighted_score: number;
    total_tokens: number;
  }>;
}
