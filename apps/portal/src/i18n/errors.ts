/** Plain-language errors (M1.5). The router sends a stable `code` with every failure; this maps it
 * to one short sentence and at most one action. Raw text (HTTP bodies, LiteLLM messages) is never the
 * main message: it appears only in Pro mode under "Details" (ErrorNote). Own module: only screens
 * that show errors ship it. */
import { lookup, type Leaves, type Vars } from "./strings";

export const errorStrings = {
  code: {
    gateway_sync: "Couldn’t sync with the model gateway. Retrying automatically.",
    key_rejected: "The provider didn’t accept this key. Check it, or create a new one.",
    rate_limited: "The provider is rate-limiting requests. It will be tried again shortly.",
    credit_limit: "This provider is out of credit. Add credit, or use a free model.",
    timeout: "The provider took too long to answer.",
    unreachable: "Couldn’t reach the provider. Check your internet connection.",
    not_found: "The provider no longer offers this model.",
    provider_error: "The provider had a problem on its side.",
    not_connected: "That model isn’t set up yet. Switchboard is syncing it now.",
    no_model: "No model is available for this request right now.",
    all_failed: "Every model that could answer this failed or was unavailable.",
    router_down: "Switchboard’s background service isn’t running.",
    router_slow: "Switchboard’s background service took too long to answer.",
    error: "Something went wrong with this request.",
    unknown: "Something went wrong.",
  },
  action: {
    retry_sync: "Retry now",
    retest: "Test again",
    replace_key: "Replace key",
    retry: "Try again",
    status: "Open status",
  },
  details: "Details",
  retrying: "Retrying…",
};

export type ErrorKey = Leaves<typeof errorStrings>;
export const tErr = (key: ErrorKey, vars?: Vars) => lookup(errorStrings, key, vars);

export type ErrorCode = keyof typeof errorStrings.code;
export type ErrorAction = keyof typeof errorStrings.action;

/** The one action that fits each code (the caller decides whether it can offer it). */
const defaultAction: Partial<Record<ErrorCode, ErrorAction>> = {
  gateway_sync: "retry_sync",
  key_rejected: "replace_key",
  timeout: "retry",
  unreachable: "retest",
  provider_error: "retry",
  all_failed: "retry",
  router_down: "status",
  router_slow: "retry",
};

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && code in errorStrings.code;
}

/** Sentence + suggested action for a code (unknown codes get the generic sentence). */
export function explainError(code: string | null | undefined): { code: ErrorCode; message: string; action: ErrorAction | null } {
  const c: ErrorCode = isErrorCode(code) ? code : "unknown";
  return { code: c, message: errorStrings.code[c], action: defaultAction[c] ?? null };
}
