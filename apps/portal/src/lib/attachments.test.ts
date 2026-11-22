import { describe, expect, it } from "vitest";
import { estimateText, formatBytes, nameFor } from "./attachments";
import type { AttachmentEstimate } from "./router-types";

const base: AttachmentEstimate = {
  tokens: 1290,
  attachment_tokens: 1032,
  documented: true,
  model: "Google AI Studio · gemini-3.1-flash-lite",
  provider: "gemini",
  local: false,
  private: false,
  needs_vision: true,
  long_document: false,
  blocked: null,
};

describe("attachments (M2.5)", () => {
  it("labels an estimate unless the provider documents its accounting", () => {
    expect(estimateText(base)).toBe("≈ 1,290 tokens on Google AI Studio · gemini-3.1-flash-lite");
    expect(estimateText({ ...base, documented: false })).toBe("≈ 1,290 tokens on Google AI Studio · gemini-3.1-flash-lite (estimate)");
    expect(estimateText({ ...base, model: null, provider: null })).toBe("≈ 1,290 tokens (estimate)");
  });
  it("says plainly when an image can't be read", () => {
    expect(estimateText({ ...base, blocked: "no_local_vision", model: null })).toMatch(/private image stays on this computer/);
    expect(estimateText({ ...base, blocked: "no_model", model: null })).toMatch(/No connected model can read images/);
  });
  it("names pasted screenshots and keeps real names", () => {
    expect(nameFor(new File([""], "chart.png", { type: "image/png" }))).toBe("chart.png");
    expect(nameFor(new File([""], "image.png", { type: "image/png" }))).toMatch(/^screenshot-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.png$/);
    expect(nameFor(new File([""], "", { type: "image/jpeg" }), 2)).toMatch(/-2\.jpg$/);
  });
  it("formats sizes", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
