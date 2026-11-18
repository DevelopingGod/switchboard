/** Status view strings (M1.5): each component in plain words, with the fix in one line. */
import { lookup, type Leaves, type Vars } from "./strings";

export const statusStrings = {
  title: "Status",
  intro: "Everything Switchboard runs on, and how to fix what isn’t working.",
  allOk: "Everything is running.",
  someDown: "{count} need attention.",
  refresh: "Check again",
  checked: "Checked {time}",
  name: {
    router: "Switchboard service",
    database: "Database",
    litellm: "Model gateway",
    model_sync: "Model sync",
    ollama: "Ollama (local models)",
    paperclip: "Paperclip (jobs)",
    hostprobe: "CLI detector",
  },
  ok: {
    router: "Running.",
    database: "Running.",
    litellm: "Running.",
    model_sync: "Your models are registered with the gateway.",
    ollama: "Running. Local and private models work.",
    paperclip: "Running.",
    hostprobe: "Running. Agent CLIs are detected.",
    provider: "Working.",
  },
  down: {
    router: "Not running, so nothing else can be checked.",
    database: "Not reachable.",
    litellm: "Not running. Chats can’t reach any model.",
    model_sync: "Out of sync with the gateway. Retrying automatically.",
    ollama: "Not reachable. Local and private models won’t work.",
    paperclip: "Not reachable. Jobs won’t run (chat still works).",
    hostprobe: "Not reachable. Agent CLIs show as unknown.",
    provider: "Needs attention.",
  },
  degraded: {
    model_sync: "Waiting for the gateway.",
  },
  fix: {
    resync: "Resync models",
    recheck_cli: "Re-check CLIs",
    retest: "Re-test provider",
  },
  howTo: "How to fix",
  instruction: {
    start_docker: "Start Docker Desktop on Windows, then wait a minute and check again.",
    open_ollama: "Open the Ollama app on Windows (it starts the local model server).",
    start_paperclip: "In an Ubuntu terminal, run: paperclipai service start",
    start_hostprobe: "In an Ubuntu terminal, run: systemctl --user restart switchboard-hostprobe",
  },
  done: {
    resync: "Models resynced.",
    recheck_cli: "CLIs checked.",
    retest: "Provider re-tested.",
  },
  lastOk: "Last synced {time}",
};

export type StatusKey = Leaves<typeof statusStrings>;
export const tStatus = (key: StatusKey, vars?: Vars) => lookup(statusStrings, key, vars);
