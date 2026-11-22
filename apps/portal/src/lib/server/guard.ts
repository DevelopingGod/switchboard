import "server-only";

/**
 * Same-origin checks for route handlers that write or spend (chat turns, uploads):
 *  - Host must be loopback (DNS rebinding),
 *  - Origin must be this same loopback origin (cross-site pages can't POST here),
 *  - Sec-Fetch-Site, when sent, must be same-origin.
 * Reads (images, downloads) use `sameSiteRead`: loopback Host, and Sec-Fetch-Site same-origin or none (a
 * link opened from the portal or typed into the address bar), never cross-site.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function sameOriginWrite(req: Request): boolean {
  const hostHeader = req.headers.get("host") ?? "";
  const host = hostHeader.replace(/:\d+$/, "");
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (!LOCAL_HOSTS.has(host) || !origin || (site !== null && site !== "same-origin")) return false;
  try {
    const o = new URL(origin);
    return LOCAL_HOSTS.has(o.hostname === "::1" ? "[::1]" : o.hostname) && o.host === hostHeader;
  } catch {
    return false;
  }
}

export function sameSiteRead(req: Request): boolean {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = req.headers.get("sec-fetch-site");
  return LOCAL_HOSTS.has(host) && (site === null || site === "same-origin" || site === "none");
}

export const forbidden = () => new Response("Forbidden", { status: 403 });
