import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";
import { LogoMark } from "@/components/kit/Logo";
import { noFlashScript } from "@/lib/prefs";
import { t } from "@/i18n/strings";

const display = Plus_Jakarta_Sans({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: t("app.name"), template: `%s · ${t("app.name")}` },
  description: t("app.tagline"),
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#cfd3ff" },
    { media: "(prefers-color-scheme: dark)", color: "#1d1654" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${display.variable} ${GeistSans.variable} ${GeistMono.variable}`}
      style={
        {
          "--font-ui": "var(--font-geist-sans)",
          "--font-mono": "var(--font-geist-mono)",
        } as React.CSSProperties
      }
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        {/* First-load splash (M1.5): CSS only, shown when the head script sets data-splash. It never
            takes pointer events and is gone by 1.2 s, or as soon as the app hydrates. */}
        <div id="sb-splash" aria-hidden="true">
          <LogoMark className="splash-mark" />
        </div>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
