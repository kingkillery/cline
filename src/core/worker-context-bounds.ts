/**
 * Worker context injection bounds.
 *
 * Hermes Kanban caps injected worker context to prevent prompt bloat from
 * deep dependency chains, retry-heavy tasks, and comment storms:
 *
 * - CTX_MAX_PRIOR_ATTEMPTS: max prior failed runs shown in full
 * - CTX_MAX_COMMENTS: max recent comments shown
 * - CTX_MAX_FIELD_BYTES: per-field cap (summary, error, metadata)
 * - CTX_MAX_BODY_BYTES: per task.body cap
 *
 * Reference: hermes_cli/kanban_db.py in NousResearch/hermes-agent
 *
 * Overridable via environment variables for per-deployment tuning.
 */

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CTX_MAX_PRIOR_ATTEMPTS = parseIntEnv("KANBAN_CTX_MAX_PRIOR_ATTEMPTS", 10);
export const CTX_MAX_COMMENTS = parseIntEnv("KANBAN_CTX_MAX_COMMENTS", 30);
export const CTX_MAX_FIELD_BYTES = parseIntEnv("KANBAN_CTX_MAX_FIELD_BYTES", 4096);
export const CTX_MAX_BODY_BYTES = parseIntEnv("KANBAN_CTX_MAX_BODY_BYTES", 8192);
export const CTX_MAX_COMMENT_BYTES = parseIntEnv("KANBAN_CTX_MAX_COMMENT_BYTES", 2048);

/**
 * Truncate a string to maxBytes, appending "..." if truncated.
 * Byte-safe: truncates at the last valid UTF-8 boundary.
 */
export function truncateBytes(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let truncated = "";
  let byteCount = 0;
  const ellipsis = "...";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const targetBytes = maxBytes - ellipsisBytes;

  if (targetBytes <= 0) return ellipsis;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (byteCount + charBytes > targetBytes) break;
    truncated += char;
    byteCount += charBytes;
  }

  return truncated + ellipsis;
}

/**
 * Slice an array to the most recent N items (context bounds).
 */
export function takeRecent<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;
  return items.slice(items.length - maxCount);
}

/**
 * Build a bounded worker context summary from prior run data.
 * Returns a compact string suitable for injection into worker system prompts.
 */
export interface PriorRunSummary {
  outcome: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export function buildBoundedContext(priorRuns: PriorRunSummary[]): string {
  const recentRuns = takeRecent(priorRuns, CTX_MAX_PRIOR_ATTEMPTS);

  if (recentRuns.length === 0) return "";

  const parts: string[] = [];
  parts.push("[Worker Context - Prior Attempts]");

  for (const [i, run] of recentRuns.entries()) {
    const outcome = truncateBytes(run.outcome, CTX_MAX_FIELD_BYTES);
    parts.push(`\nRun #${i + 1}: outcome=${outcome}`);

    if (run.summary) {
      parts.push(`  Summary: ${truncateBytes(run.summary, CTX_MAX_FIELD_BYTES)}`);
    }
    if (run.error) {
      parts.push(`  Error: ${truncateBytes(run.error, CTX_MAX_FIELD_BYTES)}`);
    }
  }

  if (priorRuns.length > CTX_MAX_PRIOR_ATTEMPTS) {
    parts.push(`\n(${priorRuns.length - CTX_MAX_PRIOR_ATTEMPTS} older attempts not shown - capped at ${CTX_MAX_PRIOR_ATTEMPTS})`);
  }

  return parts.join("\n");
}
