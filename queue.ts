import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync } from "node:fs";
import type { UsageRecord } from "./types.ts";

const MAX_RECORDS = 10_000;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class Queue {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Append a record. Enforces FIFO overflow if limits exceeded. */
  enqueue(record: UsageRecord): void {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.filePath, line, "utf-8");
    this.enforceLimit();
  }

  /** Read the first `limit` records without removing them. */
  peek(limit: number): UsageRecord[] {
    const lines = this.readLines();
    return lines.slice(0, limit).map((l) => JSON.parse(l));
  }

  /** Remove the first `count` records from the queue. */
  remove(count: number): void {
    const lines = this.readLines();
    if (count >= lines.length) {
      writeFileSync(this.filePath, "", "utf-8");
      return;
    }
    const remaining = lines.slice(count).join("\n") + "\n";
    writeFileSync(this.filePath, remaining, "utf-8");
  }

  /** Number of records in the queue. */
  size(): number {
    return this.readLines().length;
  }

  /** Timestamp (ISO string) of the oldest record, or null if empty. */
  oldestTimestamp(): string | null {
    const lines = this.readLines();
    if (lines.length === 0) return null;
    try {
      const first: UsageRecord = JSON.parse(lines[0]);
      return first.timestamp;
    } catch {
      return null;
    }
  }

  /** Drop oldest records if queue exceeds size or byte limits. */
  private enforceLimit(): void {
    // Check byte size first
    try {
      const stat = statSync(this.filePath);
      if (stat.size <= MAX_BYTES) {
        // Check record count
        const lines = this.readLines();
        if (lines.length <= MAX_RECORDS) return;
        const excess = lines.length - MAX_RECORDS;
        const trimmed = lines.slice(excess).join("\n") + "\n";
        writeFileSync(this.filePath, trimmed, "utf-8");
        return;
      }
    } catch {
      return;
    }

    // Over byte limit — drop oldest 10% at a time
    const lines = this.readLines();
    const dropCount = Math.max(1, Math.floor(lines.length * 0.1));
    const trimmed = lines.slice(dropCount).join("\n") + "\n";
    writeFileSync(this.filePath, trimmed, "utf-8");
  }

  private readLines(): string[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const content = readFileSync(this.filePath, "utf-8");
      return content.split("\n").filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  }
}
