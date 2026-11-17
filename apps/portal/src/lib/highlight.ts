/**
 * Syntax highlighting, loaded only when a reply contains a code block (its own lazy chunk).
 * highlight.js core + a small language set; output is escaped HTML from highlight.js.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const langs = { bash, css, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(langs)) hljs.registerLanguage(name, lang);
const ALIAS: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", html: "xml", yml: "yaml", md: "markdown", rs: "rust" };

/** Highlighted HTML, or null when the language is unknown (shown as plain text). */
export function highlight(code: string, lang: string | undefined): string | null {
  const name = lang ? (ALIAS[lang.toLowerCase()] ?? lang.toLowerCase()) : undefined;
  if (!name || !hljs.getLanguage(name)) return null;
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}
