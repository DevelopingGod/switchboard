import { describe, expect, it } from "vitest";
import { languageOf, parseDiff } from "./diff";
import { appendLog, emptyLog } from "./log-buffer";
import { budgetPct, bytes, costSummary, duration, mergeCommands, shellQuote } from "./job-format";
import { prettyLine } from "./log-format";

const ev = (o: unknown) => JSON.stringify(o);

describe("prettyLine (real event shapes)", () => {
  it("Claude Code: text, tool use, refusals, result; bookkeeping dropped", () => {
    expect(prettyLine(ev({ type: "system", subtype: "init" }))).toBeNull();
    expect(prettyLine(ev({ type: "assistant", message: { content: [{ type: "text", text: "I'll add it." }] } }))).toEqual({ kind: "text", text: "I'll add it." });
    expect(prettyLine(ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python3 -m unittest" } }] } }))?.text).toBe("→ Bash: python3 -m unittest");
    expect(prettyLine(ev({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Permission denied" }] } }))?.text).toContain("refused or failed: Permission denied");
    expect(prettyLine(ev({ type: "result", subtype: "success", duration_ms: 8288, total_cost_usd: 0.071 }))?.text).toBe("Run finished: success, 8 s, list price $0.071");
  });
  it("Codex and OpenCode", () => {
    expect(prettyLine(ev({ type: "item.started", item: { type: "command_execution", command: "/bin/bash -lc pwd" } }))?.text).toBe("$ /bin/bash -lc pwd");
    expect(prettyLine(ev({ type: "item.completed", item: { type: "agent_message", text: "Done." } }))?.text).toBe("Done.");
    expect(prettyLine(ev({ type: "turn.started" }))).toBeNull();
    expect(prettyLine(ev({ type: "tool_use", part: { tool: "bash", state: { input: { command: "python3 -m unittest" } } } }))?.text).toBe("→ bash: python3 -m unittest");
    expect(prettyLine(ev({ type: "text", part: { text: "All tests pass." } }))?.text).toBe("All tests pass.");
    expect(prettyLine(ev({ type: "step_finish" }))).toBeNull();
  });
  it("keeps plain text and unknown JSON", () => {
    expect(prettyLine("Ran 2 tests in 0.001s")).toEqual({ kind: "plain", text: "Ran 2 tests in 0.001s" });
    expect(prettyLine(ev({ type: "new_thing", x: 1 }))?.kind).toBe("plain");
    expect(prettyLine("{ not json")?.kind).toBe("plain");
  });
});

const DIFF = `diff --git a/a.py b/a.py
index 1..2 100644
--- a/a.py
+++ b/a.py
@@ -1,2 +1,3 @@
 x = 1
-y = 2
+y = 3
+z = 4
\\ No newline at end of file
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1 @@
+# hi
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/old.txt b/renamed.txt
deleted file mode 100644
`;

describe("parseDiff", () => {
  it("splits files and counts lines", () => {
    const f = parseDiff(DIFF);
    expect(f.map((x) => x.path)).toEqual(["a.py", "new.md", "img.png", "renamed.txt"]);
    expect([f[0].added, f[0].removed]).toEqual([2, 1]);
    expect(f[0].lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add", "add", "meta"]);
    expect(f[1].isNew && f[1].added === 1).toBe(true);
    expect(f[2].binary).toBe(true);
    expect(f[3].oldPath).toBe("old.txt");
    expect(f[3].isDeleted).toBe(true);
  });
  it("is empty for no diff and keeps a + line that looks like a header inside a hunk", () => {
    expect(parseDiff("")).toEqual([]);
    const f = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-+++ b/old\n++++ b/new\n");
    expect(f[0].lines.map((l) => [l.kind, l.text])).toEqual([["hunk", "@@ -1 +1 @@"], ["del", "+++ b/old"], ["add", "+++ b/new"]]);
  });
  it("maps extensions to languages", () => {
    expect(languageOf("src/a.tsx")).toBe("typescript");
    expect(languageOf("Makefile")).toBeUndefined();
  });
});

describe("appendLog", () => {
  it("splits chunks into lines with stable keys", () => {
    const b = appendLog(emptyLog(), "r1", [{ stream: "stdout", chunk: "a\nb\n" }, { stream: "stderr", chunk: "c" }]);
    expect(b.lines.map((l) => [l.key, l.stream, l.text])).toEqual([["r1:0", "stdout", "a"], ["r1:1", "stdout", "b"], ["r1:2", "stderr", "c"]]);
  });
  it("keeps at most max lines and counts the dropped ones", () => {
    let b = emptyLog();
    for (let i = 0; i < 30; i++) b = appendLog(b, "r", [{ chunk: `line ${i}` }], 10);
    expect(b.lines.length).toBe(10);
    expect(b.dropped).toBe(20);
    expect(b.lines[0].text).toBe("line 20");
    expect(new Set(b.lines.map((l) => l.key)).size).toBe(10);
  });
  it("returns the same buffer when nothing is added", () => {
    const b = emptyLog();
    expect(appendLog(b, "r", [])).toBe(b);
  });
});

describe("job formatting", () => {
  it("says cost not reported, free or paid", () => {
    expect(costSummary({ cost_reported: false, list_price_usd: 0, cost_usd: 0 }).kind).toBe("unreported");
    expect(costSummary({ cost_reported: true, list_price_usd: 0.134, cost_usd: 0 })).toEqual({ kind: "free", listed: "$0.13", spent: "$0.00" });
    expect(costSummary({ cost_reported: true, list_price_usd: 0.004, cost_usd: 0.004 }).listed).toBe("<$0.01");
  });
  it("caps the budget meter at 100", () => {
    expect(budgetPct({ list_price_usd: 0.5, budget_list_usd: 2 })).toBe(25);
    expect(budgetPct({ list_price_usd: 3, budget_list_usd: 2 })).toBe(100);
    expect(budgetPct({ list_price_usd: 1, budget_list_usd: 0 })).toBe(0);
  });
  it("builds copyable git commands and quotes odd paths", () => {
    const c = mergeCommands("switchboard/job-7", "/home/you/my repo");
    expect(c.merge).toBe("cd '/home/you/my repo' && git merge --no-ff switchboard/job-7");
    expect(mergeCommands("switchboard/job-7").log).toBe("git log --oneline HEAD..switchboard/job-7");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
  it("formats sizes and durations", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1536 * 1024)).toBe("1.5 MB");
    expect(duration("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z")).toBe("42 s");
    expect(duration("2026-01-01T00:00:00Z", "2026-01-01T02:05:00Z")).toBe("2 h 5 min");
  });
});
