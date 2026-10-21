import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side image proxy for video thumbnails.
 * YouTube's thumbnail CDN (i.ytimg.com) is blocked in some regions (e.g. Iran)
 * even when the site itself is reachable — proxying through the server makes
 * thumbnails work for everyone. Strict host allowlist prevents SSRF abuse.
 */
const ALLOWED = [
  "ytimg.com",
  "youtube.com",
  "ggpht.com",
  "vimeocdn.com",
  "vimeo.com",
  "tiktokcdn.com",
  "cdninstagram.com",
  "fbcdn.net",
  "twimg.com",
  "samplelib.com",
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("url") || "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: { code: "INVALID_URL", message: "Bad url." } }, { status: 400 });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return NextResponse.json({ error: { code: "INVALID_URL", message: "Bad protocol." } }, { status: 400 });
  }
  const host = target.hostname.toLowerCase();
  const allowed = ALLOWED.some((h) => host === h || host.endsWith(`.${h}`));
  if (!allowed) {
    return NextResponse.json({ error: { code: "INVALID_URL", message: "Host not allowed." } }, { status: 403 });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TubeGrab/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok || !upstream.body) {
      return placeholder(req.url);
    }
    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=86400, immutable");
    return new Response(upstream.body, { headers });
  } catch {
    return placeholder(req.url);
  }
}

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#27272a"/><circle cx="160" cy="90" r="34" fill="#3f3f46"/><path d="M150 74l26 16-26 16z" fill="#a1a1aa"/></svg>`;

function placeholder(base: string): Response {
  return new Response(PLACEHOLDER_SVG, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
  });
}
