"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "@/components/kit/CopyButton";
import { whenIdle } from "@/lib/idle-queue";
import { t } from "@/i18n/strings";
import { tChat } from "@/i18n/chat";

/**
 * Markdown for replies (lazy chunk: react-markdown + remark-gfm). Raw HTML in model output is never
 * rendered (react-markdown's default); links open in a new tab without referrer/opener.
 */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = React.useState<string | null>(null);
  React.useEffect(() => {
    // Highlighting is one idle slice per block (M4b), after the module loads in its own slice.
    let live = true;
    let cancel: (() => void) | undefined;
    cancel = whenIdle(() => {
      void import("@/lib/highlight").then(({ highlight }) => {
        if (live) cancel = whenIdle(() => live && setHtml(highlight(code, lang)));
      });
    });
    return () => {
      live = false;
      cancel?.();
    };
  }, [code, lang]);
  return (
    <div className="solid-panel not-prose my-3 overflow-hidden p-0!">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5 font-sans text-xs">
        <span className="uppercase tracking-wider text-(--solid-ink)">{lang || "code"}</span>
        <CopyButton text={code} label={tChat("chat.copyCode")} className="h-7 text-xs" />
      </div>
      <pre className="overflow-x-auto p-3 leading-relaxed" tabIndex={0}>
        {html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
    const text = String(children ?? "");
    if (!lang && !text.includes("\n")) return <code className="md-inline-code">{children}</code>;
    return <CodeBlock code={text.replace(/\n$/, "")} lang={lang} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-accent-strong underline underline-offset-4">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto" tabIndex={0} aria-label={t("a11y.more")}>
      <table>{children}</table>
    </div>
  ),
};

export default function MarkdownImpl({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
