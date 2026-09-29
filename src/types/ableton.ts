/**
 * Ableton Remote Script protocol types and interfaces
 */

export interface ScriptInfo {
  script_version: string;
  capabilities: string[];
  /** Opt-in gates inside the Remote Script (eval, record): true when the user has created the allow_<gate> file. */
  gates?: Record<string, boolean>;
}

export interface RemoteScriptResponse<T = any> {
  status: 'success' | 'error';
  result?: T;
  message?: string;
  /** Stable machine-readable error code (e.g. OUT_OF_RANGE, NOT_FOUND, TYPE_ERROR) on error responses. */
  code?: string;
  /** Structured extra information on some errors (a failed batch lists every op's outcome). */
  details?: unknown;
  /** Time the Remote Script spent running the command inside Live. */
  elapsed_ms?: number;
}

export interface RemoteScriptCommand {
  type: string;
  params?: Record<string, any>;
}
