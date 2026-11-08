import path from "node:path";

import { baseArgs, CLIENT_CHAIN, DlError, type RawInfo } from "../ytdlp";
import { parseSavenowPlaceholder, resolveSavenowUrl } from "../savenow";
import { jobsDir } from "./store";
import type { CreateJobInput } from "./types";

/** Result of the per-mode argv builders: what the spawned process needs. */
export interface BuiltJobArgs {
  ext: string;
  args: string[];
  engine: "ytdlp" | "ffmpeg";
  argsBuilder?: () => Promise<string[]>;
}

/**
 * Lazy resolver for community-mirror formats: at pump time the savenow backend
 * prepares the file server-side, then the CDN URL replaces `__URL__` in argv.
 */
function mirrorBuilder(
  ph: { videoId: string; format: string },
  makeArgs: () => string[],
): () => Promise<string[]> {
  return async () => {
    console.log(`[jobs] mirror resolution starting for ${ph.videoId}/${ph.format}`);
    const link = await resolveSavenowUrl(ph.videoId, ph.format);
    if (!link) {
      throw new DlError(
        "MIRROR_TIMEOUT",
        "The community mirror did not prepare this format in time.",
      );
    }
    console.log(`[jobs] mirror resolved ${ph.videoId}/${ph.format} → ${link.url.slice(0, 72)}…`);
    return makeArgs().map((a) => (a === "__URL__" ? link.url : a));
  };
}

function buildMp3Args(input: CreateJobInput, raw: RawInfo, jobId: string): BuiltJobArgs {
  // mode "mp3" covers every audio conversion target (mp3/m4a/opus/flac/wav)
  const target = ["mp3", "m4a", "opus", "flac", "wav"].includes(input.audioFormat ?? "")
    ? (input.audioFormat as string)
    : "mp3";
  const bitrate = [320, 192, 128].includes(input.bitrate || 0) ? input.bitrate : 320;
  return {
    ext: target,
    engine: "ytdlp",
    args: [
      ...baseArgs(),
      // same client chain as extraction, or the job re-resolves on a different
      // player client and the selection breaks (format roulette)
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-N",
      "8",
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      target,
      // lossless/pcm targets ignore quality; mp3 uses the chosen bitrate,
      // everything else re-encodes at the best sensible preset (0)
      "--audio-quality",
      target === "mp3" ? `${bitrate}K` : "0",
      "-o",
      path.join(jobsDir(), `${jobId}.%(ext)s`),
      input.webpageUrl || raw.webpage_url,
    ],
  };
}

function buildFileArgs(input: CreateJobInput, raw: RawInfo, jobId: string): BuiltJobArgs {
  // single-format server-side download (muxed video / native audio) —
  // "instant" formats go through this too so the user NEVER live-streams
  // from YouTube through the app; they always pull a local, resumable file
  const fmtId = (input.videoFormatId || "").split("|")[0];
  if (!fmtId) throw new DlError("INVALID_URL", "Missing format id.");
  const stored = raw.formats.find((f) => f.format_id === fmtId);
  const ext = (stored?.ext || "mp4").toLowerCase();
  return {
    ext,
    engine: "ytdlp",
    args: [
      ...baseArgs(),
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-N",
      "8",
      "-f",
      `${fmtId}/best`,
      "-o",
      path.join(jobsDir(), `${jobId}.%(ext)s`),
      input.webpageUrl || raw.webpage_url,
    ],
  };
}

function buildUrlFileArgs(input: CreateJobInput, raw: RawInfo, jobId: string): BuiltJobArgs {
  // proxy-provider single stream → ffmpeg remux into the target container.
  // savenow placeholders resolve lazily at pump time (their backend
  // prepares the finished file server-side, ~10-60 s) then remux runs.
  if (!input.urls?.video) throw new DlError("INVALID_URL", "Missing stream URL.");
  const fmtId = (input.videoFormatId || "").split("|")[0];
  const stored = raw.formats.find((f) => f.format_id === fmtId);
  const ext = (stored?.ext || "mp4").toLowerCase();
  // output MUST be named job.id.ext — the close handler resolves the file
  // by that exact name (also makes -y retries overwrite cleanly)
  const out = path.join(jobsDir(), `${jobId}.${ext}`);
  const isMp4 = ext === "mp4";
  const buildArgs = (src: string): string[] => [
    "-y",
    "-i",
    src,
    "-c",
    "copy",
    ...(isMp4 ? ["-movflags", "+faststart"] : []),
    "-progress",
    "pipe:1",
    out,
  ];
  const phVideo = parseSavenowPlaceholder(input.urls.video);
  if (phVideo) {
    return { ext, engine: "ffmpeg", args: [], argsBuilder: mirrorBuilder(phVideo, () => buildArgs("__URL__")) };
  }
  return { ext, engine: "ffmpeg", args: buildArgs(input.urls.video) };
}

function buildUrlAudioArgs(input: CreateJobInput, jobId: string): BuiltJobArgs {
  if (!input.urls?.audio) throw new DlError("INVALID_URL", "Missing audio stream URL.");
  const ext = "mp3";
  const bitrate = [320, 192, 128].includes(input.bitrate || 0) ? input.bitrate : 192;
  const out = path.join(jobsDir(), `${jobId}.${ext}`);
  const buildArgs = (src: string): string[] => [
    "-y",
    "-i",
    src,
    "-vn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    `${bitrate}K`,
    "-progress",
    "pipe:1",
    out,
  ];
  const phAudio = parseSavenowPlaceholder(input.urls.audio);
  if (phAudio) {
    return { ext, engine: "ffmpeg", args: [], argsBuilder: mirrorBuilder(phAudio, () => buildArgs("__URL__")) };
  }
  return { ext, engine: "ffmpeg", args: buildArgs(input.urls.audio) };
}

function buildUrlMergeArgs(input: CreateJobInput, jobId: string): BuiltJobArgs {
  if (!input.urls?.video || !input.urls?.audio)
    throw new DlError("INVALID_URL", "Missing stream URLs for merge.");
  const [vId, aId, container] = (input.videoFormatId || "").split("|");
  const ext = ["mp4", "webm", "mkv"].includes(container) ? container : "mkv";
  const out = path.join(jobsDir(), `${jobId}.${ext}`);
  const isMp4 = ext === "mp4";
  const args = [
    "-y",
    "-i",
    input.urls.video,
    "-i",
    input.urls.audio,
    "-c",
    "copy",
    ...(isMp4 ? ["-movflags", "+faststart"] : []),
    "-progress",
    "pipe:1",
    out,
  ];
  void vId;
  void aId;
  return { ext, engine: "ffmpeg", args };
}

function buildMergeArgs(input: CreateJobInput, raw: RawInfo, jobId: string): BuiltJobArgs {
  /* mode === "merge" (yt-dlp) */
  const [vId, aId, container] = (input.videoFormatId || "").split("|");
  if (!vId || !aId || !container) throw new DlError("INVALID_URL", "Bad merge request.");
  const ext = ["mp4", "webm", "mkv"].includes(container) ? container : "mkv";
  const tmpPath = path.join(jobsDir(), `${jobId}.%(ext)s`);
  // resilient selector: the exact itags first, then quality-matched
  // fallbacks — yt-dlp's client roulette means the same itag may not exist
  // on the client that answers the job's own re-resolve
  const vf = raw.formats.find((f) => f.format_id === vId);
  const h = vf?.height;
  const fps = vf?.fps;
  const qualityFallback = h
    ? `bestvideo[height<=${h}${fps ? `][fps<=${fps}` : ""}]+bestaudio/bestvideo[height<=${h}]+bestaudio`
    : "bestvideo+bestaudio";
  return {
    ext,
    engine: "ytdlp",
    args: [
      ...baseArgs(),
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-N",
      "8",
      "-f",
      `${vId}+${aId}/${qualityFallback}/bestvideo+bestaudio/best`,
      "--merge-output-format",
      ext,
      "-o",
      tmpPath,
      input.webpageUrl || raw.webpage_url,
    ],
  };
}

/** Dispatch to the per-mode argv builder. */
export function buildJobArgs(
  mode: CreateJobInput["mode"],
  input: CreateJobInput,
  raw: RawInfo,
  jobId: string,
): BuiltJobArgs {
  switch (mode) {
    case "mp3":
      return buildMp3Args(input, raw, jobId);
    case "file":
      return buildFileArgs(input, raw, jobId);
    case "urlfile":
      return buildUrlFileArgs(input, raw, jobId);
    case "urlaudio":
      return buildUrlAudioArgs(input, jobId);
    case "urlmerge":
      return buildUrlMergeArgs(input, jobId);
    case "merge":
      return buildMergeArgs(input, raw, jobId);
  }
}
