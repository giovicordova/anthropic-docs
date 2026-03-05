import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config.js";

interface CrawlRecord {
  source: string;
  startTime: number;
  endTime?: number;
  pages?: number;
  sections?: number;
  skipped?: boolean;
  error?: string;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  resultSummary: string;
  timestamp: string;
}

interface ErrorRecord {
  timestamp: string;
  tag: string;
  message: string;
  stack?: string;
}

interface InfoRecord {
  timestamp: string;
  tag: string;
  message: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export class SessionLogger {
  private sessionStart: Date;
  private filename: string;
  private infos: InfoRecord[] = [];
  private crawls: CrawlRecord[] = [];
  private toolCalls: ToolCallRecord[] = [];
  private errors: ErrorRecord[] = [];
  private finalized = false;

  constructor() {
    this.sessionStart = new Date();
    const d = this.sessionStart;
    this.filename = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-log.md`;
  }

  info(tag: string, message: string): void {
    this.infos.push({ timestamp: formatTimestamp(new Date()), tag, message });
  }

  crawlStart(source: string): void {
    this.crawls.push({ source, startTime: Date.now() });
  }

  crawlEnd(
    source: string,
    details: { pages: number; sections?: number; skipped?: boolean; error?: string }
  ): void {
    // Find the most recent crawl record for this source that has no endTime
    for (let i = this.crawls.length - 1; i >= 0; i--) {
      if (this.crawls[i].source === source && !this.crawls[i].endTime) {
        this.crawls[i].endTime = Date.now();
        this.crawls[i].pages = details.pages;
        this.crawls[i].sections = details.sections;
        this.crawls[i].skipped = details.skipped;
        this.crawls[i].error = details.error;
        return;
      }
    }
    // If no matching start found, create a standalone record
    this.crawls.push({
      source,
      startTime: Date.now(),
      endTime: Date.now(),
      ...details,
    });
  }

  toolCall(
    name: string,
    args: Record<string, unknown>,
    durationMs: number,
    outcome: { success: boolean; resultSummary: string }
  ): void {
    this.toolCalls.push({
      name,
      args,
      durationMs,
      success: outcome.success,
      resultSummary: outcome.resultSummary,
      timestamp: formatTimestamp(new Date()),
    });
  }

  error(tag: string, message: string, stack?: string): void {
    this.errors.push({ timestamp: formatTimestamp(new Date()), tag, message, stack });
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;

    const sessionEnd = new Date();
    const durationMs = sessionEnd.getTime() - this.sessionStart.getTime();

    const crawlErrors = this.crawls.filter((c) => c.error).length;
    const toolErrors = this.toolCalls.filter((t) => !t.success).length;

    const lines: string[] = [];

    // Header
    lines.push(`# Session Log -- ${this.sessionStart.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")}`);
    lines.push("");

    // Summary
    lines.push("## Summary");
    lines.push(`- Started: ${formatTimestamp(this.sessionStart)}`);
    lines.push(`- Ended: ${formatTimestamp(sessionEnd)}`);
    lines.push(`- Duration: ${formatDuration(durationMs)}`);
    lines.push(`- Crawls: ${this.crawls.length} (${crawlErrors} errors)`);
    lines.push(`- Tool calls: ${this.toolCalls.length} (${toolErrors} errors)`);
    lines.push(`- Errors: ${this.errors.length} total`);
    lines.push("");

    // Startup
    const startupInfos = this.infos.filter((i) => i.tag === "startup");
    if (startupInfos.length > 0) {
      lines.push("## Startup");
      for (const info of startupInfos) {
        lines.push(`- ${info.message}`);
      }
      lines.push("");
    }

    // Crawls
    if (this.crawls.length > 0) {
      lines.push("## Crawls");
      for (const crawl of this.crawls) {
        const outcome = crawl.error
          ? "FAILED"
          : crawl.skipped
            ? "SKIPPED"
            : "OK";
        lines.push(`### ${crawl.source} -- ${outcome}`);
        lines.push(`- Started: ${formatTimestamp(new Date(crawl.startTime))}`);
        if (crawl.endTime) {
          lines.push(`- Duration: ${formatDuration(crawl.endTime - crawl.startTime)}`);
        }
        if (crawl.pages !== undefined) {
          lines.push(`- Pages: ${crawl.pages}`);
        }
        if (crawl.sections !== undefined) {
          lines.push(`- Sections: ${crawl.sections}`);
        }
        if (crawl.error) {
          lines.push(`- Error: ${crawl.error}`);
        }
        lines.push("");
      }
    }

    // Tool Calls
    if (this.toolCalls.length > 0) {
      lines.push("## Tool Calls");
      lines.push("| # | Tool | Args | Duration | Outcome |");
      lines.push("|---|------|------|----------|---------|");
      for (let i = 0; i < this.toolCalls.length; i++) {
        const t = this.toolCalls[i];
        const argsStr = Object.entries(t.args)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");
        const outcomeStr = t.success ? `OK -- ${t.resultSummary}` : `ERROR -- ${t.resultSummary}`;
        lines.push(`| ${i + 1} | ${t.name} | ${argsStr} | ${t.durationMs}ms | ${outcomeStr} |`);
      }
      lines.push("");
    }

    // Errors
    if (this.errors.length > 0) {
      lines.push("## Errors");
      lines.push("| Time | Tag | Message |");
      lines.push("|------|-----|---------|");
      for (const e of this.errors) {
        lines.push(`| ${e.timestamp} | ${e.tag} | ${e.message} |`);
      }
      lines.push("");
    }

    // Shutdown
    const shutdownInfos = this.infos.filter((i) => i.tag === "shutdown");
    if (shutdownInfos.length > 0) {
      lines.push("## Shutdown");
      for (const info of shutdownInfos) {
        lines.push(`- ${info.message}`);
      }
      lines.push("");
    }

    // General info (poll, crawl, etc.)
    const otherInfos = this.infos.filter((i) => i.tag !== "startup" && i.tag !== "shutdown");
    if (otherInfos.length > 0) {
      lines.push("## Events");
      for (const info of otherInfos) {
        lines.push(`- [${info.timestamp}] [${info.tag}] ${info.message}`);
      }
      lines.push("");
    }

    const report = lines.join("\n");

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOG_DIR, this.filename), report, "utf-8");
    } catch (err) {
      console.error(`[logger] Failed to write log file: ${(err as Error).message}`);
    }
  }
}

export const logger = new SessionLogger();
