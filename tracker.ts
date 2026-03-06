import { randomUUID } from "node:crypto";
import { Queue } from "./queue.ts";
import { Syncer } from "./sync.ts";
import type { UsageRecord } from "./types.ts";

/**
 * Extract usage data from an llm_output event and enqueue it.
 * Deliberately ignores `assistantTexts` and `lastAssistant` — only reads
 * model, provider, and token usage numbers.
 */
export function trackUsage(
  event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      total?: number;
    };
  },
  queue: Queue,
  syncer: Syncer,
  paused: () => boolean,
): void {
  if (paused()) return;

  const usage = event.usage;
  // Skip if no usage data at all
  if (!usage) return;

  const total = usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
  // Skip zero-token calls
  if (total === 0) return;

  const record: UsageRecord = {
    call_id: randomUUID(),
    run_id: event.runId,
    session_id: event.sessionId,
    model: event.model,
    provider: event.provider,
    usage: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cache_read: usage.cacheRead ?? 0,
      total,
    },
    timestamp: new Date().toISOString(),
  };

  queue.enqueue(record);
  syncer.onNewRecord();
}
