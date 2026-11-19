# 0003. App shell: a left sidebar replaces the top pill bar

Status: accepted (2026-11-19)

## Context
The M0.5 shell was a sticky top pill bar (desktop) plus a bottom tab bar (phones), and the chat page carried its
own thread list column. That left no room for global recents, the budget and health, or Simple/Pro and appearance
controls without crowding the bar, and the thread list was reachable only on /chat. The M3b brief asks for one
sidebar: logo, collapse (⌘B), New chat, Search (⌘K), the six sections, global recents, and a bottom block with the
budget dial, a health dot, Simple/Pro, theme, Settings and profile. Hard limits: ≤ 200 KB JS per route (`/chat` was
197.7 KB), nothing clipped and no sideways scroll at any width ≥ 360 px (and 125%/150% zoom).

## Options
1. **shadcn/Radix Sidebar** (or another component library). Complete, but adds JS to every route and a design that
   would need re-skinning; the budget has ~2 KB of headroom on `/chat` and `/welcome`.
2. **Hand-built CSS + a small React component**, driven by the `html[data-sidebar]` pref that is already set before
   paint (no flash on load). Collapse is a CSS grid-column transition; the phone drawer is a fixed panel with a
   scrim, a focus trap, `inert` on the page behind and `visibility:hidden` when closed.
3. Keep the top bar and add a second, secondary sidebar. More chrome, two navigation models.

## Decision
Option 2. Details that matter:
- **Recents are global, paginated and searched on the server.** `GET /chat/threads?limit&cursor&q` (keyset on
  `updated_at,id`, indexed; pinned apart on the first page). The sidebar loads them after hydration through a
  portal route handler (the admin token never reaches the browser), "Show more" fetches the next page, search is
  debounced and covers every chat. The chat page no longer loads or renders a thread list (it was O(all threads)
  and capped at 200). Window events (`sb:threads-changed`, `sb:thread-updated`) keep chat and sidebar in step.
- **Budget:** `TopNav`, `PillTabs` use in the shell, `MobileNav` and the chat `ThreadList` column are gone; the
  recents list and the budget dial are lazy chunks with same-size placeholders (no layout shift). Result: `/chat`
  197.7 → 195.4 KB; other routes +0.4 to +0.9 KB (`/welcome` 197.4 → 198.3, the tightest).
- **Footer trimmed:** per-service health and today's spend moved to the sidebar (health dot, budget dial); the
  footer keeps quota, value saved, version and links, which exist nowhere else. One shared `/api/status` poll
  feeds both (`SummaryProvider`).
- **Viewport breakpoints lie once a 272 px sidebar sits beside the content.** Grids that switched columns at
  `sm`/`md`/`lg` now use `repeat(auto-fill, minmax(min(100%, Nrem), 1fr))`, and the wizard's two-column layout
  moved from `lg` to `xl`. The new layout test (6 widths × 8 pages, 6 zoom levels) found these; it asserts no
  horizontal scroll and that no sidebar control is outside the window or the sidebar.
- **A11y:** the collapsed rail's mode button uses an icon (axe: visible text must be in the accessible name);
  the drawer returns focus to the menu button on Esc and is axe-clean in both themes.
- **Page header:** slim and sticky (menu button on phones, section name as plain text because every page keeps its
  own h1, and a slot for page actions via a portal).

## Consequences
- Every new route inherits the shell; a page that needs its own column logic should use container-friendly grids,
  not viewport breakpoints.
- ⌘B is now global (it toggles the drawer on phone-sized windows).
- All visual baselines change; they are regenerated once, after the Rules UI lands.
