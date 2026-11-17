import { describe, expect, it } from "vitest";
import { applySlash, leadingSlash, slashMatches } from "./slash";

describe("slash commands", () => {
  it("lists all commands for a bare slash and filters by prefix", () => {
    expect(slashMatches("/")).toHaveLength(7);
    expect(slashMatches("/co")).toEqual(["code"]);
    expect(slashMatches("/C")).toEqual(["chat", "code"]);
  });
  it("stops hinting once a command is complete or text follows", () => {
    expect(slashMatches("/code ")).toBeNull();
    expect(slashMatches("hello /code")).toBeNull();
    expect(slashMatches("/zzz")).toBeNull();
  });
  it("applies and detects commands", () => {
    expect(applySlash("private")).toBe("/private ");
    expect(leadingSlash("/image a fox")).toBe("image");
    expect(leadingSlash("/nope x")).toBeNull();
    expect(leadingSlash("no command")).toBeNull();
  });
});
