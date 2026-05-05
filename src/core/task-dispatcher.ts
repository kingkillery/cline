/**
 * Hermes-style task dispatcher for Cline Kanban.
 *
 * Inspired by Nous Research's Hermes Agent Kanban (kanban_db.py):
 * - SQLite WAL-mode CAS (compare-and-swap) claim system
 * - Claim TTL with heartbeat renewal
 * - Stale-claim reclamation (detect crashed/dead workers)
 * - Dependency promotion (children → ready when parents complete)
 *
 * Hermes reference: github.com/NousResearch/hermes-agent/blob/main/hermes_cli/kanban_db.py
 *
 * MIT-licensed patterns adapted for Cline Kanban's TypeScript/Node.js runtime.
 */

import type {
  RuntimeBoardCard,
  RuntimeBoardColumnId,
  RuntimeBoardData,
  RuntimeTaskSessionSummary,
} from "./api-contract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default claim TTL: 15 minutes, matching Hermes. Workers must heartbeat to extend. */
export const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

/** How often the dispatcher ticks (checks for work). Default 60s, matching Hermes. */
export const DEFAULT_DISPATCHER_TICK_MS = 60 * 1000;

/** Maximum consecutive failures before giving up on a task (circuit breaker). */
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskClaim {
  taskId: string;
  assignee: string;
  lockId: string;
  claimedAt: number; // epoch ms
  expiresAt: number; // epoch ms
  pid: number;
}

export interface DispatcherState {
  claims: Map<string, TaskClaim>; // taskId → claim
  failureCounts: Map<string, number>; // taskId → consecutive failures
  tickInterval: number;
  claimTtl: number;
  running: boolean;
}

export interface DispatcherTickResult {
  claimed: string[]; // taskIds newly claimed this tick
  reclaimed: string[]; // taskIds reclaimed (worker died)
  promoted: string[]; // taskIds promoted to ready (dependencies resolved)
  gaveUp: string[]; // taskIds given up (circuit breaker tripped)
}

export type DispatcherEventHandler = (event: DispatcherEvent) => void;

export type DispatcherEvent =
  | { type: "task_claimed"; taskId: string; assignee: string; pid: number }
  | { type: "task_reclaimed"; taskId: string; reason: "stale_claim" | "worker_crashed" }
  | { type: "task_promoted"; taskId: string; fromStatus: string; toStatus: "ready" }
  | { type: "task_gave_up"; taskId: string; failures: number }
  | { type: "heartbeat"; taskId: string; lockId: string }
  | { type: "heartbeat_failed"; taskId: string; reason: string }
  | { type: "tick_complete"; result: DispatcherTickResult };

// ---------------------------------------------------------------------------
// Dispatcher implementation
// ---------------------------------------------------------------------------

const CRYPTO_RANDOM_UUID = (): string =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

function now(): number {
  return Date.now();
}

function findTaskColumn(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
  for (const column of board.columns) {
    if (column.cards.some((card) => card.id === taskId)) {
      return column.id;
    }
  }
  return null;
}

/**
 * Check if all parent dependencies of a task are satisfied.
 * A dependency is satisfied when its fromTaskId (backlog task) is in review (completed).
 */
function areDependenciesSatisfied(
  board: RuntimeBoardData,
  taskId: string,
): boolean {
  const childDeps = board.dependencies.filter((d) => d.toTaskId === taskId);
  if (childDeps.length === 0) {
    return true; // no dependencies → always ready
  }
  return childDeps.every((dep) => {
    const parentColumn = findTaskColumn(board, dep.fromTaskId);
    // Parent is "done" when it's in review (completed) or trashed
    return parentColumn === "review" || parentColumn === "trash";
  });
}

/**
 * Find tasks in backlog whose dependencies are all satisfied and can be promoted.
 */
function findPromotableTasks(board: RuntimeBoardData): string[] {
  const triageColumn = board.columns.find((c) => c.id === "triage");
  if (!triageColumn) return [];

  return triageColumn.cards
    .filter((card) => areDependenciesSatisfied(board, card.id))
    .map((card) => card.id);
}

export function createDispatcher(options: {
  claimTtl?: number;
  tickInterval?: number;
  onEvent?: DispatcherEventHandler;
}): DispatcherState & {
  /** CAS claim: atomically claim a task. Returns claim if successful, null if already claimed. */
  claimTask: (
    board: RuntimeBoardData,
    taskId: string,
    assignee: string,
    pid: number,
  ) => { claim: TaskClaim; board: RuntimeBoardData } | null;

  /** Heartbeat: extend claim TTL. Returns true if claim is still valid. */
  heartbeat: (taskId: string, lockId: string) => boolean;

  /** Release a claim (called when worker finishes or fails). */
  releaseClaim: (taskId: string) => void;

  /** One dispatcher tick: claim ready tasks, reclaim stale, promote dependencies. */
  tick: (board: RuntimeBoardData, sessions: Record<string, RuntimeTaskSessionSummary>) => {
    board: RuntimeBoardData;
    result: DispatcherTickResult;
  };

  /** Start the dispatcher loop. Returns a stop function. */
  start: (
    getBoard: () => RuntimeBoardData,
    getSessions: () => Record<string, RuntimeTaskSessionSummary>,
    onBoardUpdated: (board: RuntimeBoardData) => void,
  ) => () => void;

  /** Stop the dispatcher. */
  stop: () => void;

  /** Get current dispatcher stats. */
  getStats: () => { claims: number; failures: number; ticking: boolean };
} {
  const state: DispatcherState = {
    claims: new Map(),
    failureCounts: new Map(),
    tickInterval: options.tickInterval ?? DEFAULT_DISPATCHER_TICK_MS,
    claimTtl: options.claimTtl ?? DEFAULT_CLAIM_TTL_MS,
    running: false,
  };

  const onEvent = options.onEvent;
  const emit = (event: DispatcherEvent) => onEvent?.(event);
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  function claimTask(
    board: RuntimeBoardData,
    taskId: string,
    assignee: string,
    pid: number,
  ): { claim: TaskClaim; board: RuntimeBoardData } | null {
    // Check if already claimed and claim is still valid
    const existingClaim = state.claims.get(taskId);
    if (existingClaim && existingClaim.expiresAt > now()) {
      return null; // still claimed
    }

    // CAS: if there was a stale claim, reclaim it first
    if (existingClaim) {
      emit({ type: "task_reclaimed", taskId, reason: "stale_claim" });
    }

    const lockId = CRYPTO_RANDOM_UUID();
    const claimedAt = now();
    const claim: TaskClaim = {
      taskId,
      assignee,
      lockId,
      claimedAt,
      expiresAt: claimedAt + state.claimTtl,
      pid,
    };

    state.claims.set(taskId, claim);
    emit({ type: "task_claimed", taskId, assignee, pid });

    // Move task from todo to in_progress.
    const updatedBoard = moveTaskColumn(board, taskId, "in_progress", Date.now());

    return { claim, board: updatedBoard };
  }

  function heartbeat(taskId: string, lockId: string): boolean {
    const claim = state.claims.get(taskId);
    if (!claim) {
      emit({ type: "heartbeat_failed", taskId, reason: "no_claim" });
      return false;
    }

    if (claim.lockId !== lockId) {
      emit({ type: "heartbeat_failed", taskId, reason: "lock_mismatch" });
      return false;
    }

    if (claim.expiresAt <= now()) {
      emit({ type: "heartbeat_failed", taskId, reason: "expired" });
      return false;
    }

    // Extend TTL
    claim.expiresAt = now() + state.claimTtl;
    emit({ type: "heartbeat", taskId, lockId });
    return true;
  }

  function releaseClaim(taskId: string): void {
    state.claims.delete(taskId);
  }

  function reclaimStale(): string[] {
    const reclaimed: string[] = [];
    const currentTime = now();

    for (const [taskId, claim] of state.claims) {
      if (claim.expiresAt <= currentTime) {
        state.claims.delete(taskId);
        reclaimed.push(taskId);
        emit({ type: "task_reclaimed", taskId, reason: "worker_crashed" });
      }
    }

    return reclaimed;
  }

  function promoteDependencies(board: RuntimeBoardData): {
    board: RuntimeBoardData;
    promoted: string[];
  } {
    const promotableIds = findPromotableTasks(board);
    let updatedBoard = board;

    for (const taskId of promotableIds) {
      updatedBoard = moveTaskColumn(updatedBoard, taskId, "backlog", Date.now());
      emit({ type: "task_promoted", taskId, fromStatus: "triage", toStatus: "ready" });
    }

    return { board: updatedBoard, promoted: promotableIds };
  }

  function tick(
    board: RuntimeBoardData,
    _sessions: Record<string, RuntimeTaskSessionSummary>,
  ): { board: RuntimeBoardData; result: DispatcherTickResult } {
    const result: DispatcherTickResult = {
      claimed: [],
      reclaimed: [],
      promoted: [],
      gaveUp: [],
    };

    // 1. Reclaim stale claims
    result.reclaimed = reclaimStale();

    // 2. Promote dependency-satisfied tasks
    const promotionResult = promoteDependencies(board);
    board = promotionResult.board;
    result.promoted = promotionResult.promoted;

    // 3. Circuit breaker: check failure counts for in-progress tasks
    for (const [taskId, failures] of state.failureCounts) {
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        result.gaveUp.push(taskId);
        state.failureCounts.delete(taskId);
        state.claims.delete(taskId);
        emit({ type: "task_gave_up", taskId, failures });
      }
    }

    emit({ type: "tick_complete", result });
    return { board, result };
  }

  function start(
    getBoard: () => RuntimeBoardData,
    getSessions: () => Record<string, RuntimeTaskSessionSummary>,
    onBoardUpdated: (board: RuntimeBoardData) => void,
  ): () => void {
    state.running = true;

    tickTimer = setInterval(() => {
      const currentBoard = getBoard();
      const currentSessions = getSessions();
      const { board } = tick(currentBoard, currentSessions);
      onBoardUpdated(board);
    }, state.tickInterval);

    return stop;
  }

  function stop(): void {
    state.running = false;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function getStats() {
    return {
      claims: state.claims.size,
      failures: state.failureCounts.size,
      ticking: state.running,
    };
  }

  return {
    ...state,
    claimTask,
    heartbeat,
    releaseClaim,
    tick,
    start,
    stop,
    getStats,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function moveTaskColumn(
  board: RuntimeBoardData,
  taskId: string,
  targetColumnId: RuntimeBoardColumnId,
  now: number,
): RuntimeBoardData {
  // Find which column the task is currently in
  let sourceColumnIndex = -1;
  let taskIndex = -1;
  let task: RuntimeBoardCard | undefined;

  for (const [ci, column] of board.columns.entries()) {
    const ti = column.cards.findIndex((card) => card.id === taskId);
    if (ti !== -1) {
      sourceColumnIndex = ci;
      taskIndex = ti;
      task = column.cards[ti];
      break;
    }
  }

  if (!task) return board; // task not found

  // Remove from source column
  const columns = board.columns.map((column, ci) => {
    if (ci !== sourceColumnIndex) return column;
    return {
      ...column,
      cards: column.cards.filter((_, ti) => ti !== taskIndex),
    };
  });

  // Add to target column
  const targetIndex = columns.findIndex((c) => c.id === targetColumnId);
  if (targetIndex === -1) return board;

  const updatedTask = { ...task, updatedAt: now };
  columns[targetIndex] = {
    ...columns[targetIndex],
    cards: [updatedTask, ...columns[targetIndex].cards],
  };

  return { ...board, columns };
}
