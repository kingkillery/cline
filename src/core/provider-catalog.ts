/**
 * Unified provider abstraction layer for Cline Kanban.
 *
 * Combines Cline SDK provider config (openai-codex, anthropic, copilot) with
 * the agent catalog (codex, claude, copilot CLI agents) into a single model
 * that the dispatcher can use to route tasks to the right provider+agent.
 *
 * Inspired by Hermes Agent's multi-provider credential pool system
 * (hermes auth add/list/reset) and provider-agnostic model routing.
 */

import type { RuntimeAgentId } from "./api-contract";

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

export type ProviderAuthType = "oauth" | "api_key" | "gh_token";

export type ProviderHealthStatus = "healthy" | "warning" | "exhausted" | "unknown";

export interface ProviderConfig {
  /** Provider ID (matches Cline SDK provider IDs and Hermes credential pools) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Which CLI agents this provider supports */
  agentIds: RuntimeAgentId[];
  /** How this provider authenticates */
  authType: ProviderAuthType;
  /** Environment variables for API key detection */
  envKeys: string[];
  /** Default model when none is specified */
  defaultModelId: string;
  /** Quick smoke-test command (for health checks) */
  testCommand?: string;
}

export interface ProviderHealth {
  providerId: string;
  status: ProviderHealthStatus;
  lastChecked: number | null;
  errorMessage: string | null;
  remainingCredits?: number | null;
}

/** The canonical provider catalog: single source of truth for all providers. */
export const PROVIDER_CATALOG: ProviderConfig[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    agentIds: ["codex"],
    authType: "oauth",
    envKeys: [],
    defaultModelId: "gpt-5.5",
    testCommand: "codex --version",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    agentIds: ["claude"],
    authType: "api_key",
    envKeys: ["ANTHROPIC_API_KEY"],
    defaultModelId: "claude-sonnet-4",
    testCommand: "claude --version",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    agentIds: ["copilot"],
    authType: "gh_token",
    envKeys: ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN"],
    defaultModelId: "copilot-default",
    testCommand: "gh auth status",
  },
  {
    id: "cline",
    name: "Cline",
    agentIds: ["cline"],
    authType: "oauth",
    envKeys: ["CLINE_API_KEY"],
    defaultModelId: "cline-default",
    testCommand: "cline --version",
  },
  {
    id: "factory",
    name: "Factory Droid",
    agentIds: ["droid"],
    authType: "api_key",
    envKeys: [],
    defaultModelId: "droid-default",
    testCommand: "droid --version",
  },
];

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** Resolve which CLI agent to use for a given provider. */
export function resolveAgentForProvider(providerId: string): RuntimeAgentId | null {
  const normalized = providerId.trim().toLowerCase();
  const config = PROVIDER_CATALOG.find((p) => p.id === normalized);
  return config?.agentIds[0] ?? null;
}

/** Find all providers that support a given CLI agent. */
export function resolveProvidersForAgent(agentId: RuntimeAgentId): ProviderConfig[] {
  return PROVIDER_CATALOG.filter((p) => p.agentIds.includes(agentId));
}

/** Get the provider config by ID. */
export function getProviderConfig(providerId: string): ProviderConfig | null {
  const normalized = providerId.trim().toLowerCase();
  return PROVIDER_CATALOG.find((p) => p.id === normalized) ?? null;
}

/** Check if a provider has auth configured (API key in env, OAuth token present, etc). */
export function isProviderConfigured(providerId: string): boolean {
  const config = getProviderConfig(providerId);
  if (!config) return false;

  switch (config.authType) {
    case "api_key":
      return config.envKeys.some((key) => Boolean(process.env[key]));
    case "oauth":
      // OAuth providers require stored tokens, so report them as checkable.
      return true;
    case "gh_token":
      return config.envKeys.some((key) => Boolean(process.env[key]));
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Provider health tracking
// ---------------------------------------------------------------------------

const providerHealth = new Map<string, ProviderHealth>();

export function getProviderHealth(providerId: string): ProviderHealth {
  return (
    providerHealth.get(providerId) ?? {
      providerId,
      status: "unknown",
      lastChecked: null,
      errorMessage: null,
    }
  );
}

export function setProviderHealth(
  providerId: string,
  update: Partial<Omit<ProviderHealth, "providerId">>,
): ProviderHealth {
  const current = getProviderHealth(providerId);
  const next: ProviderHealth = {
    ...current,
    ...update,
    providerId,
    lastChecked: Date.now(),
  };
  providerHealth.set(providerId, next);
  return next;
}

export function getAllProviderHealth(): ProviderHealth[] {
  // Ensure all known providers have an entry
  for (const config of PROVIDER_CATALOG) {
    if (!providerHealth.has(config.id)) {
      providerHealth.set(config.id, {
        providerId: config.id,
        status: "unknown",
        lastChecked: null,
        errorMessage: null,
      });
    }
  }
  return [...providerHealth.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

// ---------------------------------------------------------------------------
// Provider health check (smoke test)
// ---------------------------------------------------------------------------

export interface ProviderHealthCheckResult {
  providerId: string;
  status: ProviderHealthStatus;
  message: string;
}

/**
 * Run a quick health check for all configured providers.
 * For now this is a structural check (are creds present?).
 * Full live health checks (actual API calls) can be added later.
 */
export function runProviderHealthChecks(): ProviderHealthCheckResult[] {
  return PROVIDER_CATALOG.map((config) => {
    const configured = isProviderConfigured(config.id);
    const status: ProviderHealthStatus = configured ? "healthy" : "warning";
    const message = configured
      ? `${config.name} credentials detected`
      : `${config.name} credentials not found (set ${config.envKeys.join(" or ") || "run OAuth login"})`;

    setProviderHealth(config.id, {
      status,
      errorMessage: configured ? null : message,
    });

    return { providerId: config.id, status, message };
  });
}
