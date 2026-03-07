import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Queue } from "./queue.ts";
import { Syncer } from "./sync.ts";
import { trackUsage } from "./tracker.ts";
import type {
  GoldchainConfig,
  VerifyResponse,
  RankResponse,
  LeaderboardResponse,
} from "./types.ts";

// Types from OpenClaw plugin SDK (referenced structurally, not imported)
type PluginApi = {
  id: string;
  name: string;
  config: unknown;
  pluginConfig?: Record<string, unknown>;
  runtime: unknown;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  registerCommand: (cmd: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: { args?: string }) => { text: string } | Promise<{ text: string }>;
  }) => void;
  resolvePath: (input: string) => string;
  on: (hookName: string, handler: (event: any, ctx: any) => void | Promise<void>, opts?: { priority?: number }) => void;
};

const DEFAULT_API_BASE = "https://api.goldchain.club";

function loadConfig(pluginDir: string): GoldchainConfig | null {
  const configPath = join(pluginDir, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.token) return null;
    return {
      token: parsed.token,
      api_base_url: parsed.api_base_url || DEFAULT_API_BASE,
    };
  } catch {
    return null;
  }
}

function saveConfig(pluginDir: string, token: string, apiBase?: string): void {
  const configPath = join(pluginDir, "config.json");
  const data = {
    token,
    api_base_url: apiBase || DEFAULT_API_BASE,
  };
  writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // chmod may fail on some systems, not critical
  }
}

function formatTimeSince(ms: number): string {
  if (ms === 0) return "never";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

const plugin = {
  id: "goldchain-rank",
  name: "Goldchain Rank",
  description: "Token usage tracker for Goldchain leaderboard",
  version: "1.0.0",

  register(api: PluginApi) {
    const pluginDir = join(new URL(".", import.meta.url).pathname);
    let config = loadConfig(pluginDir);

    // Shared mutable state — initialized after login
    let queue: Queue | null = null;
    let syncer: Syncer | null = null;

    function activate() {
      if (!config) return;
      const queuePath = join(pluginDir, "queue.jsonl");
      queue = new Queue(queuePath);
      syncer = new Syncer(config, queue, api.logger);
      api.logger.info("Goldchain Rank: active and tracking usage.");
    }

    // If already configured, start immediately
    if (config) {
      activate();
    } else {
      api.logger.info(
        "Goldchain Rank: no token configured. Use /goldchain login <token> to get started.",
      );
    }

    // ─── Core hook: capture LLM usage (no conversation content) ───
    api.on("llm_output", (event, _ctx) => {
      if (queue && syncer) {
        trackUsage(event, queue, syncer, () => syncer!.state.paused);
      }
    });

    // ─── Register /goldchain command ───
    api.registerCommand({
      name: "goldchain",
      description: "Goldchain Rank — login, status, sync, rank, pause, resume, leaderboard",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const args = (ctx.args ?? "").trim();
        const sub = args.split(/\s+/)[0].toLowerCase();

        switch (sub) {
          // ─── Login: verify token with server, then save ───
          case "login": {
            const token = args.slice(5).trim(); // strip "login "
            if (!token) {
              return {
                text: "Usage: /goldchain login <your-api-token>\nGet your token at https://goldchain.club",
              };
            }

            try {
              const base = config?.api_base_url || DEFAULT_API_BASE;
              const res = await fetch(`${base}/v1/auth/verify`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000),
              });

              if (!res.ok) {
                return { text: `Login failed: invalid token (HTTP ${res.status})` };
              }

              const data: VerifyResponse = await res.json();
              if (!data.valid) {
                return { text: `Login failed: ${data.message || "invalid token"}` };
              }

              // Save token and activate
              saveConfig(pluginDir, token, config?.api_base_url);
              config = { token, api_base_url: config?.api_base_url || DEFAULT_API_BASE };
              activate();

              return {
                text: `Login successful! Welcome, ${data.display_name}.\nGoldchain Rank is now active. Restart OpenClaw to begin tracking.`,
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { text: `Login failed: ${msg}` };
            }
          }

          case "status":
          case "": {
            if (!syncer || !queue) {
              return {
                text: "Goldchain Rank: not configured.\nUse /goldchain login <token> to get started.",
              };
            }
            const size = queue.size();
            const oldest = queue.oldestTimestamp();
            const { consecutive_failures, last_sync_at, paused } = syncer.state;
            const lines = [
              `Goldchain Rank: ${paused ? "PAUSED" : "Active"}`,
              `Queue: ${size} events`,
              `Last sync: ${formatTimeSince(last_sync_at)}`,
            ];
            if (oldest) lines.push(`Oldest record: ${oldest}`);
            if (consecutive_failures > 0)
              lines.push(`Consecutive failures: ${consecutive_failures}`);
            return { text: lines.join("\n") };
          }

          case "sync": {
            if (!syncer) {
              return { text: "Not configured. Use /goldchain login <token> first." };
            }
            const result = await syncer.forceSync();
            if (result.ok) {
              return { text: `Synced ${result.accepted ?? 0} events successfully.` };
            }
            return { text: `Sync failed: ${result.error}` };
          }

          case "pause": {
            if (!syncer) {
              return { text: "Not configured. Use /goldchain login <token> first." };
            }
            syncer.state.paused = true;
            return { text: "Goldchain Rank: data collection paused." };
          }

          case "resume": {
            if (!syncer) {
              return { text: "Not configured. Use /goldchain login <token> first." };
            }
            syncer.state.paused = false;
            syncer.state.consecutive_failures = 0;
            return { text: "Goldchain Rank: data collection resumed." };
          }

          case "rank": {
            if (!config) {
              return { text: "Not configured. Use /goldchain login <token> first." };
            }
            try {
              const url = `${config.api_base_url}/v1/users/me/rank`;
              const res = await fetch(url, {
                headers: { Authorization: `Bearer ${config.token}` },
                signal: AbortSignal.timeout(10_000),
              });
              if (!res.ok) return { text: `Failed to fetch rank: HTTP ${res.status}` };
              const data: RankResponse = await res.json();
              return {
                text: [
                  `Rank: #${data.rank}`,
                  `Name: ${data.display_name}`,
                  `Total tokens: ${data.total_tokens.toLocaleString()}`,
                  `Weighted score: ${data.weighted_score.toLocaleString()}`,
                  `Period: ${data.period}`,
                ].join("\n"),
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { text: `Failed to fetch rank: ${msg}` };
            }
          }

          case "leaderboard":
          case "lb": {
            const base = config?.api_base_url || DEFAULT_API_BASE;
            try {
              const url = `${base}/v1/leaderboard`;
              const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
              if (!res.ok) return { text: `Failed to fetch leaderboard: HTTP ${res.status}` };
              const data: LeaderboardResponse = await res.json();
              const header = `Goldchain Leaderboard (${data.period}):\n`;
              const rows = data.entries
                .map((e) => `#${e.rank} ${e.display_name} — ${e.weighted_score.toLocaleString()} pts`)
                .join("\n");
              return { text: header + rows };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return { text: `Failed to fetch leaderboard: ${msg}` };
            }
          }

          case "logout": {
            if (!config) {
              return { text: "Not logged in." };
            }
            if (syncer) syncer.destroy();
            syncer = null;
            queue = null;
            config = null;
            const configPath = join(pluginDir, "config.json");
            try {
              writeFileSync(configPath, "{}\n", "utf-8");
            } catch { /* ignore */ }
            return { text: "Logged out. Token removed." };
          }

          default:
            return {
              text: [
                "Usage: /goldchain <command>",
                "  login <token> — Bind your Goldchain account",
                "  logout        — Remove token and stop tracking",
                "  status        — Show plugin status",
                "  sync          — Force sync pending events",
                "  pause         — Pause data collection",
                "  resume        — Resume data collection",
                "  rank          — Show your current rank",
                "  leaderboard   — Show top 20 leaderboard",
              ].join("\n"),
            };
        }
      },
    });
  },
};

export default plugin;
