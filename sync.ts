import { randomUUID } from "node:crypto";
import { sign } from "./crypto.ts";
import { Queue } from "./queue.ts";
import type {
  GoldchainConfig,
  ReportPayload,
  ReportResponse,
  SyncState,
  UsageRecord,
} from "./types.ts";

const CLIENT_VERSION = "1.0.0";
const BATCH_SIZE = 50;
const DEBOUNCE_MS = 10_000; // 10 seconds
const MAX_STALE_MS = 60_000; // 60 seconds
const MAX_QUEUE_SIZE = 50;
const MAX_AUTO_RETRIES = 10;

// Backoff: 30s, 60s, 120s, then cap
const BACKOFF_BASE_MS = 30_000;

export class Syncer {
  private config: GoldchainConfig;
  private queue: Queue;
  private log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  state: SyncState;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: GoldchainConfig,
    queue: Queue,
    logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  ) {
    this.config = config;
    this.queue = queue;
    this.log = logger;
    this.state = {
      consecutive_failures: 0,
      last_sync_at: 0,
      paused: false,
    };

    // Periodic stale check every 15 seconds
    this.staleCheckTimer = setInterval(() => this.checkStale(), 15_000);
  }

  /** Called when a new record is enqueued. Manages trigger logic. */
  onNewRecord(): void {
    if (this.state.paused) return;

    // Check max queue size trigger
    const size = this.queue.size();
    if (size >= MAX_QUEUE_SIZE) {
      this.flush();
      return;
    }

    // Start debounce timer if not running
    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.flush();
      }, DEBOUNCE_MS);
    }
  }

  /** Check if oldest record exceeds max staleness. */
  private checkStale(): void {
    if (this.state.paused) return;
    const oldest = this.queue.oldestTimestamp();
    if (!oldest) return;
    const ageMs = Date.now() - new Date(oldest).getTime();
    if (ageMs >= MAX_STALE_MS) {
      this.flush();
    }
  }

  /** Flush the queue: take up to BATCH_SIZE records, sign, and POST. */
  async flush(): Promise<{ ok: boolean; accepted?: number; error?: string }> {
    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Check if auto-paused due to too many failures
    if (this.state.consecutive_failures >= MAX_AUTO_RETRIES && !this.state.paused) {
      this.log.warn(
        `Goldchain: auto-paused after ${MAX_AUTO_RETRIES} consecutive failures. Use /goldchain sync to retry.`,
      );
      this.state.paused = true;
      return { ok: false, error: "auto-paused" };
    }

    const records = this.queue.peek(BATCH_SIZE);
    if (records.length === 0) {
      return { ok: true, accepted: 0 };
    }

    const payload: ReportPayload = {
      user_id: this.config.user_id,
      batch_id: randomUUID(),
      events: records,
      client_version: CLIENT_VERSION,
    };

    const payloadJson = JSON.stringify(payload);
    const timestampMs = String(Date.now());
    const signature = sign(
      this.config.secret_key,
      this.config.user_id,
      timestampMs,
      payloadJson,
    );

    const url = `${this.config.api_base_url}/v1/usage/report`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goldchain-Signature": signature,
          "X-Goldchain-User": this.config.user_id,
          "X-Goldchain-Timestamp": timestampMs,
        },
        body: payloadJson,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const body: ReportResponse = await res.json();

      if (body.status === "error") {
        throw new Error(`Server error: ${body.code} — ${body.message}`);
      }

      // Success or partial — remove sent records from queue
      this.queue.remove(records.length);
      this.state.consecutive_failures = 0;
      this.state.last_sync_at = Date.now();
      this.log.info(
        `Goldchain: synced ${body.accepted ?? records.length} events (duplicates: ${body.duplicates ?? 0})`,
      );
      return { ok: true, accepted: body.accepted ?? records.length };
    } catch (err: unknown) {
      this.state.consecutive_failures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`Goldchain: sync failed (${this.state.consecutive_failures}x): ${msg}`);

      // Schedule backoff retry if under limit
      if (this.state.consecutive_failures < MAX_AUTO_RETRIES && this.state.consecutive_failures >= 3) {
        this.scheduleBackoff();
      }

      return { ok: false, error: msg };
    }
  }

  /** Exponential backoff retry: 30s → 60s → 120s (capped). */
  private scheduleBackoff(): void {
    if (this.backoffTimer) return;
    const attempt = this.state.consecutive_failures - 3; // 0, 1, 2, ...
    const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), 120_000);
    this.log.info(`Goldchain: retry in ${delayMs / 1000}s`);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.flush();
    }, delayMs);
  }

  /** Force unpause and immediate flush (for /goldchain sync). */
  async forceSync(): Promise<{ ok: boolean; accepted?: number; error?: string }> {
    this.state.paused = false;
    this.state.consecutive_failures = 0;
    return this.flush();
  }

  /** Clean up timers. */
  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
  }
}
