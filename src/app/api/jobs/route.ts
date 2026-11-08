import { NextResponse } from "next/server";
import { createJob, jobStore, publicJob, ensureCleanupTimer, type CreateJobInput } from "@/lib/jobs";
import { getInfo, type RawInfo, type YtRawFormat, DlError } from "@/lib/ytdlp";
import { isProxySource } from "@/lib/extract";
import { lookupKeyFor, videoKeyFromFormat } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/jobs — server-side conversion jobs (merge / MP3).
 *
 * POST creates a job and returns immediately; the client polls GET /api/jobs/{id}
 * then streams the finished file from /api/jobs/{id}/file.
 *
 * Proxy-provider formats (Piped/Invidious) carry direct stream URLs instead of
 * itags, so they are routed to ffmpeg-based urlmerge/urlaudio jobs that pull
 * the provider URLs directly.
 */
export async function GET() {
  ensureCleanupTimer();
  const jobs = [...jobStore().values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  return NextResponse.json({ jobs: jobs.map(publicJob) });
}

export async function POST(req: Request) {
  let body: {
    infoId?: string;
    mode?: "merge" | "mp3" | "file";
    videoFormatId?: string;
    bitrate?: number;
    audioFormat?: string;
    title?: string;
    webpageUrl?: string;
    duration?: number;
    quality?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_URL", message: "Bad request." } }, { status: 400 });
  }

  const infoId = body.infoId || "";
  const entry = getInfo(infoId);
  if (!entry) {
    return NextResponse.json(
      { error: { code: "EXPIRED", message: "Session expired — fetch the video again." } },
      { status: 410 },
    );
  }
  const raw = entry.raw;
  const mode: "merge" | "mp3" | "file" =
    body.mode === "mp3" ? "mp3" : body.mode === "file" ? "file" : "merge";

  try {
    console.log("[jobs] POST body:", JSON.stringify(body));
    const input = buildInput(infoId, raw, mode, body);
    const job = createJob(input);
    return NextResponse.json({ job: publicJob(job) });
  } catch (e) {
    console.error("[jobs] POST /api/jobs create failed:", e);
    if (e instanceof DlError) {
      const status = e.code === "EXPIRED" ? 410 : e.code === "NO_FFMPEG" ? 503 : 500;
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status });
    }
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not start the job." } },
      { status: 500 },
    );
  }
}

function buildInput(
  infoId: string,
  raw: RawInfo,
  mode: "merge" | "mp3" | "file",
  body: { videoFormatId?: string; bitrate?: number; audioFormat?: string; title?: string; webpageUrl?: string; duration?: number; quality?: string },
): CreateJobInput {
  const base: CreateJobInput = {
    infoId,
    mode,
    videoFormatId: body.videoFormatId,
    bitrate: body.bitrate,
    audioFormat: body.audioFormat,
    webpageUrl: body.webpageUrl || raw.webpage_url,
    title: body.title || raw.title,
    duration: body.duration || raw.duration,
    qualityLabel: body.quality,
    formatSpec: body.videoFormatId || body.audioFormat,
  };

  // direct-link registration: in-app jobs land in the SAME StoredFile
  // registry as /api/dl hits (same lookupKey → same stable token link)
  const webpageUrl = base.webpageUrl || "";
  const fmtSpec = body.videoFormatId || body.audioFormat || "";
  if (/^https?:\/\//.test(webpageUrl) && fmtSpec) {
    if (mode === "mp3") {
      base.dlKey = lookupKeyFor(webpageUrl, fmtSpec, body.bitrate);
    } else {
      // semantic key: itags drift between sessions — identity is
      // height+fps+codec+container so every variant shares one stored file
      const vId = fmtSpec.split("|")[0];
      const vf = raw.formats.find((f) => f.format_id === vId) ?? null;
      base.dlKey = videoKeyFromFormat(webpageUrl, vf, fmtSpec);
    }
  }

  if (!isProxySource(raw)) return base;

  /* ---------- provider-sourced: route to ffmpeg direct-URL jobs ---------- */
  const formats = raw.formats;

  if (mode === "mp3") {
    const bestAudio = bestAudioFormat(formats);
    if (bestAudio?.url) {
      return { ...base, mode: "urlaudio", urls: { audio: bestAudio.url } };
    }
    return base;
  }

  if (mode === "file") {
    // single instant format from a provider → ffmpeg remux of the direct URL
    const fmtId = (body.videoFormatId || "").split("|")[0];
    const stored = formats.find((f) => f.format_id === fmtId);
    if (stored?.url) {
      return { ...base, mode: "urlfile", urls: { video: stored.url } };
    }
    return base;
  }

  const [vId, , container] = (body.videoFormatId || "").split("|");
  const video = formats.find((f) => f.format_id === vId);
  const audio = bestAudioFormat(formats, container);
  if (video?.url && audio?.url) {
    return {
      ...base,
      mode: "urlmerge",
      urls: { video: video.url, audio: audio.url },
    };
  }
  /* Honest failure: a merge was requested but the provider fleet cannot
   * supply both direct streams. Answer with a real code instead of letting
   * buildMergeArgs reject the shape with a cryptic "Bad merge request". */
  throw new DlError("NO_FORMATS", "Provider has no compatible stream pair for this quality — fetch again to try another instance.");
}

function bestAudioFormat(formats: YtRawFormat[], container?: string): YtRawFormat | null {
  const audios = formats.filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none" && f.url);
  if (audios.length === 0) return null;
  const family = container && /webm|mkv/.test(container) ? ["opus", "vorbis"] : ["mp4a", "aac"];
  return (
    audios
      .map((f) => {
        const s = (f.acodec ?? "").toLowerCase();
        const fam = family.some((x) => s.includes(x)) ? 1 : 0;
        return { f, score: fam * 1000 + (f.abr ?? f.tbr ?? 0) };
      })
      .sort((a, b) => b.score - a.score)[0]?.f ?? null
  );
}
