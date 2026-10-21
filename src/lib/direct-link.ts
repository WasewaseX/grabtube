/**
 * Self-contained "direct link" helpers for external download managers
 * (IDM, Free Download Manager, aria2, wget, curl…).
 *
 * A direct link encodes EVERYTHING it needs in the query string — no infoId,
 * no session, no cookie:
 *
 *     /api/dl?u=<base64url webpage_url>&f=<format>&q=<quality>&t=<title>&b=<bitrate>
 *
 * so it keeps working hours later, after server restarts, and can be shared
 * or queued in a download manager. The server re-resolves a fresh media URL
 * on every hit (cached briefly so an IDM multi-segment swarm shares one mint).
 */

export interface DirectLinkParams {
  webpageUrl: string;
  /** instant format id ("18"), merge composite ("137|140|mp4"), or "mp3" */
  format: string;
  quality?: string;
  title?: string;
  bitrate?: number;
}

export function b64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function directLinkPath(params: DirectLinkParams): string {
  const sp = new URLSearchParams();
  sp.set("u", b64urlEncode(params.webpageUrl));
  sp.set("f", params.format);
  if (params.quality) sp.set("q", params.quality);
  if (params.title) sp.set("t", params.title.slice(0, 90));
  if (params.bitrate) sp.set("b", String(params.bitrate));
  return `/api/dl?${sp.toString()}`;
}

export function directLinkUrl(origin: string, params: DirectLinkParams): string {
  return `${origin.replace(/\/+$/, "")}${directLinkPath(params)}`;
}
