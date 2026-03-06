import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Queue } from "./queue.ts";
import { Syncer } from "./sync.ts";
import { trackUsage } from "./tracker.ts";
import type { GoldchainConfig, RankResponse, LeaderboardResponse } from "./types.ts";

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

function loadConfig(pluginDir: string): GoldchainConfig | null {
  const configPath = join(pluginDir, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.user_id || !parsed.secret_key) return null;
    return {
      user_id: parsed.user_id,
      secret_key: parsed.secret_key,
      api_base_url: parsed.api_base_url || "https://api.goldchain.xyz",
    };
  } catch {
    return null;
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
    // Resolve plugin directory from this file's location
    const pluginDir = join(new URL(".", import.meta.url).pathname);
    const config = loadConfig(pluginDir);

    if (!config) {
      api.logger.warn(
        "Goldchain Rank: missing or invalid config.json (need user_id + secret_key). Plugin disabled.",
      );
      return;
    }

    const queuePath = join(pluginDir, "queue.jsonl");
    const queue = new Queue(queuePath);
    const syncer = new Syncer(config, queue, api.logger);

    api.logger.info(`Goldchain Rank: active for user ${config.user_id}`);

    // ─── Core hook: capture LLM usage (no conversation content) ───
    api.on("llm_output", (event, _ctx) => {
      trackUsage(event, queue, syncer, () => syncer.state.paused);
    });

    // ─── Register /goldchain command ───
    api.registerCommand({
      name: "goldchain",
      description: "Goldchain Rank — status, sync, rank, pause, resume, leaderboard",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const sub = (ctx.args ?? "").trim().split(/\s+/)[0].toLowerCase();

        switch (sub) {
          case "status":
          case "": {
            const size = queue.size();
            const oldest = queue.oldestTimestamp();
            const { consecutive_failures, last_sync_at, paused } = syncer.state;
            const lines = [
              `Goldchain Rank: ${paused ? "PAUSED" : "Active"}`,
              `User: ${config.user_id}`,
              `Queue: ${size} events`,
              `Last sync: ${formatTimeSince(last_sync_at)}`,
            ];
            if (oldest) lines.push(`Oldest record: ${oldest}`);
            if (consecutive_failures > 0)
              lines.push(`Consecutive failures: ${consecutive_failures}`);
            return { text: lines.join("\n") };
          }

          case "sync": {
            const result = await syncer.forceSync();
            if (result.ok) {
              return { text: `Synced ${result.accepted ?? 0} events successfully.` };
            }
            return { text: `Sync failed: ${result.error}` };
          }

          case "pause": {
            syncer.state.paused = true;
            return { text: "Goldchain Rank: data collection paused." };
          }

          case "resume": {
            syncer.state.paused = false;
            syncer.state.consecutive_failures = 0;
            return { text: "Goldchain Rank: data collection resumed." };
          }

          case "rank": {
            try {
              const url = `${config.api_base_url}/v1/users/${config.user_id}/rank`;
              const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
            try {
              const url = `${config.api_base_url}/v1/leaderboard`;
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

          default:
            return {
              text: [
                "Usage: /goldchain <command>",
                "  status       — Show plugin status",
                "  sync         — Force sync pending events",
                "  pause        — Pause data collection",
                "  resume       — Resume data collection",
                "  rank         — Show your current rank",
                "  leaderboard  — Show top 20 leaderboard",
              ].join("\n"),
            };
        }
      },
    });
  },
};

export default plugin;
