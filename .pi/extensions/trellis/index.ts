import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type JsonObject = Record<string, unknown>;

interface PiExtensionContext {
  hasUI?: boolean;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

interface PiBeforeAgentStartEvent {
  systemPrompt?: string;
}

interface PiContextEvent {
  messages?: unknown[];
}

interface PiToolCallEvent {
  toolName?: string;
  input?: JsonObject;
}

const TRELLIS_AGENT_JSONL: Record<string, string> = {
  "trellis-implement": "implement.jsonl",
  implement: "implement.jsonl",
  "trellis-check": "check.jsonl",
  check: "check.jsonl",
};

function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (
      existsSync(join(current, ".trellis")) ||
      existsSync(join(current, ".pi"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitizeKey(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 160);
}

function hashValue(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function createProcessContextKey(projectRoot: string): string {
  return `pi_process_${hashValue(
    [projectRoot, process.pid, Date.now(), randomBytes(8).toString("hex")].join(
      ":",
    ),
  )}`;
}

function callString(
  callback: (() => string | undefined) | undefined,
): string | null {
  if (!callback) return null;
  try {
    return stringValue(callback());
  } catch {
    return null;
  }
}

function lookupString(data: unknown, keys: string[]): string | null {
  if (!isJsonObject(data)) return null;
  for (const key of keys) {
    const value = stringValue(data[key]);
    if (value) return value;
  }
  for (const nestedKey of [
    "input",
    "properties",
    "event",
    "hook_input",
    "hookInput",
  ]) {
    const nested = data[nestedKey];
    const value = lookupString(nested, keys);
    if (value) return value;
  }
  return null;
}

function normalizeTaskRef(raw: string): string | null {
  let normalized = raw.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("tasks/")) normalized = `.trellis/${normalized}`;
  return normalized;
}

function taskRefToDir(projectRoot: string, taskRef: string): string {
  if (taskRef.startsWith("/")) return taskRef;
  if (taskRef.startsWith(".trellis/")) return join(projectRoot, taskRef);
  return join(projectRoot, ".trellis", "tasks", taskRef);
}

function sessionFileHasCurrentTask(path: string): boolean {
  try {
    const context = JSON.parse(readText(path)) as JsonObject;
    return !!normalizeTaskRef(stringValue(context.current_task) ?? "");
  } catch {
    return false;
  }
}

function activeRuntimeContextKeys(projectRoot: string): string[] {
  const sessionsDir = join(projectRoot, ".trellis", ".runtime", "sessions");
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((key) =>
        sessionFileHasCurrentTask(join(sessionsDir, `${key}.json`)),
      );
  } catch {
    return [];
  }
}

function adoptExistingContextKey(
  projectRoot: string,
  contextKey: string,
): string {
  const sessionsDir = join(projectRoot, ".trellis", ".runtime", "sessions");
  if (sessionFileHasCurrentTask(join(sessionsDir, `${contextKey}.json`))) {
    return contextKey;
  }

  const keys = activeRuntimeContextKeys(projectRoot);
  const processKeys = keys.filter((key) => key.startsWith("pi_process_"));
  const candidates = processKeys.length ? processKeys : keys;
  return candidates.length === 1 ? candidates[0] : contextKey;
}

function resolveContextKey(
  input: unknown,
  ctx?: PiExtensionContext,
  fallback?: string | null,
): string | null {
  const override = stringValue(process.env.TRELLIS_CONTEXT_ID);
  if (override) return sanitizeKey(override) || hashValue(override);

  const sessionId =
    callString(ctx?.sessionManager?.getSessionId) ??
    stringValue(process.env.PI_SESSION_ID) ??
    stringValue(process.env.PI_SESSIONID) ??
    lookupString(input, ["session_id", "sessionId", "sessionID"]);
  if (sessionId) return `pi_${sanitizeKey(sessionId) || hashValue(sessionId)}`;

  const transcriptPath =
    callString(ctx?.sessionManager?.getSessionFile) ??
    lookupString(input, ["transcript_path", "transcriptPath", "transcript"]);
  if (transcriptPath) return `pi_transcript_${hashValue(transcriptPath)}`;

  return fallback ?? null;
}

function readCurrentTask(
  projectRoot: string,
  platformInput?: unknown,
  ctx?: PiExtensionContext,
  contextKeyOverride?: string | null,
): string | null {
  const contextKey =
    contextKeyOverride ?? resolveContextKey(platformInput, ctx);
  if (contextKey) {
    try {
      const rawContext = readText(
        join(
          projectRoot,
          ".trellis",
          ".runtime",
          "sessions",
          `${contextKey}.json`,
        ),
      );
      const context = JSON.parse(rawContext) as JsonObject;
      const taskRef = normalizeTaskRef(stringValue(context.current_task) ?? "");
      if (taskRef) return taskRefToDir(projectRoot, taskRef);
    } catch {
      // Missing or malformed session context means no active task.
    }
  }

  return null;
}

function readJsonlFiles(
  projectRoot: string,
  taskDir: string,
  jsonlName: string,
): string {
  const jsonlPath = join(taskDir, jsonlName);
  const lines = readText(jsonlPath).split(/\r?\n/);
  const chunks: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as JsonObject;
      const file = typeof row.file === "string" ? row.file : "";
      if (!file) continue;
      const content = readText(join(projectRoot, file));
      if (content) {
        chunks.push(`## ${file}\n\n${content}`);
      }
    } catch {
      // Seed rows and malformed lines must not block context injection.
    }
  }

  return chunks.join("\n\n---\n\n");
}

function buildTrellisContext(
  projectRoot: string,
  agent: string,
  platformInput?: unknown,
  ctx?: PiExtensionContext,
  contextKey?: string | null,
): string {
  const taskDir = readCurrentTask(projectRoot, platformInput, ctx, contextKey);
  if (!taskDir) {
    return "No active Trellis task found. Read .trellis/ before proceeding.";
  }

  const prd = readText(join(taskDir, "prd.md"));
  const info = readText(join(taskDir, "info.md"));
  const jsonlName = TRELLIS_AGENT_JSONL[agent] ?? "";
  const specContext = jsonlName
    ? readJsonlFiles(projectRoot, taskDir, jsonlName)
    : "";

  return [
    "## Trellis Task Context",
    `Task directory: ${taskDir}`,
    "",
    "### prd.md",
    prd || "(missing)",
    info ? "\n### info.md\n" + info : "",
    specContext ? "\n### Curated Spec / Research Context\n" + specContext : "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Workflow-state breadcrumb (TypeScript port of the shared workflow-state
// hook used by class-1 platforms).
//
// Pi is extension-backed and MUST NOT receive Python hook scripts under .pi/.
// We therefore parse `.trellis/workflow.md` `[workflow-state:STATUS]...
// [/workflow-state:STATUS]` blocks directly in TypeScript and emit the
// per-turn `<workflow-state>` breadcrumb in `before_agent_start` and `input`.
// Tag regex mirrors the shared parser so the breadcrumb body stays
// byte-identical with hook-driven platforms.
// ---------------------------------------------------------------------------

const WORKFLOW_STATE_TAG_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;

function loadWorkflowBreadcrumbs(projectRoot: string): Record<string, string> {
  const workflow = readText(join(projectRoot, ".trellis", "workflow.md"));
  if (!workflow) return {};
  const result: Record<string, string> = {};
  for (const match of workflow.matchAll(WORKFLOW_STATE_TAG_RE)) {
    const status = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (status && body) result[status] = body;
  }
  return result;
}

function readActiveTaskStatus(
  projectRoot: string,
  taskDir: string,
): { taskId: string; status: string } | null {
  try {
    const data = JSON.parse(
      readText(join(taskDir, "task.json")),
    ) as JsonObject;
    const status = stringValue(data.status);
    if (!status) return null;
    const id = stringValue(data.id) ?? taskDir.split(/[\\/]/).pop() ?? "";
    return { taskId: id, status };
  } catch {
    return null;
  }
}

function buildWorkflowStateBreadcrumb(
  projectRoot: string,
  contextKey: string | null,
): string {
  const templates = loadWorkflowBreadcrumbs(projectRoot);
  const taskDir = readCurrentTask(
    projectRoot,
    undefined,
    undefined,
    contextKey,
  );
  let header: string;
  let lookupKey: string;
  if (!taskDir) {
    header = "Status: no_task\nSource: session";
    lookupKey = "no_task";
  } else {
    const info = readActiveTaskStatus(projectRoot, taskDir);
    if (!info) {
      header = "Status: no_task\nSource: session";
      lookupKey = "no_task";
    } else {
      header = `Task: ${info.taskId} (${info.status})\nSource: session`;
      lookupKey = info.status;
    }
  }
  const body = templates[lookupKey] ?? "Refer to workflow.md for current step.";
  return `<workflow-state>\n${header}\n${body}\n</workflow-state>`;
}

// ---------------------------------------------------------------------------
// Session overview (developer / git branch / active tasks)
//
// Spawns `python .trellis/scripts/get_context.py` (the same script other
// platform session-start hooks invoke) to keep developer/git/active-task
// summary byte-identical with class-1 platforms. Failure is non-fatal — we
// emit an empty overview rather than block the conversation.
// ---------------------------------------------------------------------------

const SESSION_OVERVIEW_TIMEOUT_MS = 5000;

function pythonExecutable(): string {
  const override = stringValue(process.env.TRELLIS_PYTHON);
  if (override) return override;
  return process.platform === "win32" ? "python" : "python";
}

function buildSessionOverview(
  projectRoot: string,
  contextKey: string | null,
): string {
  const script = join(projectRoot, ".trellis", "scripts", "get_context.py");
  if (!isExistingFile(script)) return "";
  try {
    const result = spawnSync(pythonExecutable(), [script], {
      cwd: projectRoot,
      env: contextKey
        ? { ...process.env, TRELLIS_CONTEXT_ID: contextKey }
        : process.env,
      encoding: "utf-8",
      timeout: SESSION_OVERVIEW_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) return "";
    const stdout = (result.stdout ?? "").trim();
    if (!stdout) return "";
    return `<session-overview>\n${stdout}\n</session-overview>`;
  } catch {
    return "";
  }
}

// Per-turn cache so input + before_agent_start in the same turn don't double-spawn.
class TurnContextCache {
  private key: string | null = null;
  private timestamp = 0;
  private workflowState = "";
  private sessionOverview = "";
  // Refresh window: per-turn injections that fire close together share a
  // single python spawn; anything older than this re-runs the resolver.
  private static readonly TTL_MS = 1500;

  get(
    projectRoot: string,
    contextKey: string | null,
  ): { workflowState: string; sessionOverview: string } {
    const now = Date.now();
    if (this.key === contextKey && now - this.timestamp < TurnContextCache.TTL_MS) {
      return {
        workflowState: this.workflowState,
        sessionOverview: this.sessionOverview,
      };
    }
    this.workflowState = buildWorkflowStateBreadcrumb(projectRoot, contextKey);
    this.sessionOverview = buildSessionOverview(projectRoot, contextKey);
    this.key = contextKey;
    this.timestamp = now;
    return {
      workflowState: this.workflowState,
      sessionOverview: this.sessionOverview,
    };
  }
}

function commandStartsWithTrellisContext(command: string): boolean {
  const trimmed = command.trimStart();
  return (
    /^export\s+TRELLIS_CONTEXT_ID=/.test(trimmed) ||
    /^TRELLIS_CONTEXT_ID=/.test(trimmed) ||
    /^env\s+.*\bTRELLIS_CONTEXT_ID=/.test(trimmed)
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function injectTrellisContextIntoBash(
  event: unknown,
  contextKey: string,
): boolean {
  const toolCall = event as PiToolCallEvent;
  if (toolCall.toolName !== "bash" || !isJsonObject(toolCall.input)) {
    return false;
  }

  const rawCommand = toolCall.input.command;
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    return false;
  }
  if (commandStartsWithTrellisContext(rawCommand)) {
    return false;
  }

  toolCall.input.command = `export TRELLIS_CONTEXT_ID=${shellQuote(contextKey)}; ${rawCommand}`;
  return true;
}

export default function trellisExtension(pi: {
  registerTool?: (tool: JsonObject) => void;
  on?: (
    event: string,
    handler: (event: unknown, ctx?: PiExtensionContext) => unknown,
  ) => void;
  cwd?: string;
}): void {
  const projectRoot = findProjectRoot(pi.cwd ?? process.cwd());
  const processContextKey = createProcessContextKey(projectRoot);
  let currentContextKey: string | null = null;
  const turnContextCache = new TurnContextCache();

  const buildPerTurnInjection = (contextKey: string | null): string => {
    const { workflowState, sessionOverview } = turnContextCache.get(
      projectRoot,
      contextKey,
    );
    return [workflowState, sessionOverview].filter(Boolean).join("\n\n");
  };

  const getContextKey = (input?: unknown, ctx?: PiExtensionContext): string => {
    const resolvedContextKey = resolveContextKey(
      input,
      ctx,
      currentContextKey ?? processContextKey,
    );
    currentContextKey = adoptExistingContextKey(
      projectRoot,
      resolvedContextKey ?? processContextKey,
    );
    return currentContextKey;
  };

  // subagent 工具已移除：trellis 派发场景由当前 agent 直接完成。

  pi.on?.("session_start", (event, ctx) => {
    getContextKey(event, ctx);
    ctx?.ui?.notify?.(
      "Trellis project context is available. Use /trellis-continue to resume the current task.",
      "info",
    );
  });
  pi.on?.("before_agent_start", (event, ctx) => {
    const contextKey = getContextKey(event, ctx);
    const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
    const context = buildTrellisContext(
      projectRoot,
      "trellis-implement",
      event,
      ctx,
      contextKey,
    );
    const perTurn = buildPerTurnInjection(contextKey);
    return {
      systemPrompt: [current, context, perTurn].filter(Boolean).join("\n\n"),
    };
  });
  pi.on?.("context", (event, ctx) => {
    getContextKey(event, ctx);
    const messages = (event as PiContextEvent).messages;
    return Array.isArray(messages) ? { messages } : undefined;
  });
  pi.on?.("input", (event, ctx) => {
    const contextKey = getContextKey(event, ctx);
    const additionalContext = buildPerTurnInjection(contextKey);
    return additionalContext
      ? { action: "continue", additionalContext, systemPrompt: additionalContext }
      : { action: "continue" };
  });
  pi.on?.("tool_call", (event, ctx) => {
    const contextKey = getContextKey(event, ctx);
    injectTrellisContextIntoBash(event, contextKey);
    return undefined;
  });
}
