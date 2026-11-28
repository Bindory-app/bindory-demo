/**
 * Per-turn structured timing recorder for Mori chat turns.
 *
 * Passed explicitly through request/tool context (no global state, no external dependencies) so
 * both the model tool loop and deterministic fast-path flows record stages in the same format.
 * Emits exactly one JSON log line per turn via `console.log` with no message text, card photos,
 * user IDs, or credentials.
 */

export type ModelTiming = {
  turn: number;
  model: string;
  ms: number;
  ok: boolean;
  code?: string;
};

export type ToolTiming = {
  name: string;
  ms: number;
  ok: boolean;
  cache?: Record<string, boolean>;
};

export type TurnOutcome = "done" | "error" | "aborted";

export type TurnTimingSummary = {
  event: "mori.turn";
  total_ms: number;
  outcome: TurnOutcome;
  error_code?: string;
  model_turns: number;
  models: ModelTiming[];
  tools: ToolTiming[];
  stages?: Record<string, number>;
  cache?: Record<string, boolean>;
};

export type TurnTimer = {
  recordModel(entry: ModelTiming): void;
  recordTool(entry: ToolTiming): void;
  recordStage(name: string, ms: number): void;
  recordCache(name: string, hit: boolean): void;
  finish(outcome: TurnOutcome, errorCode?: string): TurnTimingSummary;
  flush(outcome: TurnOutcome, errorCode?: string): TurnTimingSummary;
};

export function createTurnTimer(
  now: () => number = () => Date.now(),
  log: (line: string) => void = (line) => console.log(line),
): TurnTimer {
  const startedAt = now();
  const models: ModelTiming[] = [];
  const tools: ToolTiming[] = [];
  const stages: Record<string, number> = {};
  const cache: Record<string, boolean> = {};
  let flushedSummary: TurnTimingSummary | null = null;

  const roundMs = (ms: number) => Math.max(0, Math.round(ms));

  function finish(outcome: TurnOutcome, errorCode?: string): TurnTimingSummary {
    const summary: TurnTimingSummary = {
      event: "mori.turn",
      total_ms: roundMs(now() - startedAt),
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
      model_turns: models.length,
      models: models.map((m) => ({ ...m, ms: roundMs(m.ms) })),
      tools: tools.map((t) => ({
        ...t,
        ms: roundMs(t.ms),
        ...(t.cache && Object.keys(t.cache).length ? { cache: { ...t.cache } } : {}),
      })),
      ...(Object.keys(stages).length ? { stages: { ...stages } } : {}),
      ...(Object.keys(cache).length ? { cache: { ...cache } } : {}),
    };
    return summary;
  }

  return {
    recordModel(entry) {
      models.push({ ...entry, ms: roundMs(entry.ms) });
    },
    recordTool(entry) {
      tools.push({
        ...entry,
        ms: roundMs(entry.ms),
        ...(entry.cache && Object.keys(entry.cache).length ? { cache: { ...entry.cache } } : {}),
      });
    },
    recordStage(name, ms) {
      stages[name] = roundMs((stages[name] ?? 0) + ms);
    },
    recordCache(name, hit) {
      cache[name] = hit;
    },
    finish,
    flush(outcome, errorCode) {
      if (flushedSummary) return flushedSummary;
      flushedSummary = finish(outcome, errorCode);
      log(JSON.stringify(flushedSummary));
      return flushedSummary;
    },
  };
}
