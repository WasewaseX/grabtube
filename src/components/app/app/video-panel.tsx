"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { PublicFormat, PublicInfo } from "../../../lib/ytdlp";
import { fmtCodec, fmtHeight, qualityHeight } from "./format-utils";
import { CODECS, QUALITIES } from "./constants";
import { codecAvailability, containersLabel, pickAudioFormat, pickVideoFormat } from "./selection";
import { VideoHead } from "./video-head";
import { CodecChips, QualityGrid } from "./quality-grid";
import { AudioPicker } from "./audio-picker";
import { DownloadRow } from "./download-row";

interface VideoPanelProps {
  info: PublicInfo;
  audioMode: boolean;
  setAudioMode: (v: boolean) => void;
  quality: string;
  setQuality: (q: string) => void;
  codec: string;
  setCodec: (c: string) => void;
  audioFmt: string;
  setAudioFmt: (a: string) => void;
  mp3Bitrate: number;
  setMp3Bitrate: (b: number) => void;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
  onDirectLink: (fmt: PublicFormat, bitrate?: number) => void;
}

export function VideoPanel(p: VideoPanelProps) {
  const { info } = p;
  const vids = info.videoFormats ?? [];
  const auds = info.audioFormats ?? [];

  /* keep selection valid when a new video arrives */
  useEffect(() => {
    const heights = new Set(vids.map(fmtHeight));
    if (!heights.has(qualityHeight(p.quality))) {
      const best = [...heights].sort((a, b) => b - a).find((h) => h <= 1080) ?? [...heights][0];
      if (best) p.setQuality(`${best}p`);
    }
  }, [info.infoId]);

  const selHeight = qualityHeight(p.quality);
  const atHeight = useMemo(() => vids.filter((f) => fmtHeight(f) === selHeight), [vids, selHeight]);
  const codecAvailable = useMemo(() => codecAvailability(vids), [vids]);
  const pick = useCallback(
    (wantCodec: string) => pickVideoFormat(vids, atHeight, selHeight, wantCodec),
    [atHeight, selHeight, vids],
  );
  const chosen = useMemo(() => pick(p.codec), [pick, p.codec]);
  const audioPick = useCallback((name: string) => pickAudioFormat(auds, name), [auds]);
  const audioChosen = audioPick(p.audioFmt);
  const containers = useMemo(() => containersLabel(vids), [vids]);

  const download = () => {
    if (p.audioMode) {
      if (audioChosen) p.onStart(audioChosen, p.audioFmt === "MP3" ? p.mp3Bitrate : undefined);
    } else if (chosen) {
      p.onStart(chosen);
    }
  };

  const disabled = p.audioMode ? !audioChosen : !chosen;

  return (
    <section className="card video-card">
      <VideoHead info={info} />
      <div className="seg-row">
        <button className={"seg" + (!p.audioMode ? " active" : "")} onClick={() => p.setAudioMode(false)}>
          Video
        </button>
        <button className={"seg" + (p.audioMode ? " active" : "")} onClick={() => p.setAudioMode(true)}>
          Audio
        </button>
      </div>
      {!p.audioMode ? (
        <>
          <QualityGrid qualities={QUALITIES} vids={vids} quality={p.quality} onPick={(q) => setQualityLocal(p, q)} />
          <CodecChips codecs={CODECS} codec={p.codec} available={codecAvailable} onPick={p.setCodec} />
        </>
      ) : (
        <AudioPicker fmt={p.audioFmt} onPick={p.setAudioFmt} mp3Bitrate={p.mp3Bitrate} onBitrate={p.setMp3Bitrate} />
      )}
      <div className="meta-row">
        <span className="muted">Container</span> {containers}
      </div>
      <DownloadRow
        disabled={disabled}
        onDownload={download}
        onDirectLink={() => {
          const fmt = p.audioMode ? audioChosen : chosen;
          if (!fmt) return;
          p.onDirectLink(fmt, p.audioFmt === "MP3" ? p.mp3Bitrate : undefined);
        }}
      />
    </section>
  );
}

/** quality click also snaps the codec chip to one available at that height */
function setQualityLocal(p: VideoPanelProps, q: string) {
  p.setQuality(q);
  const h = qualityHeight(q);
  const at = p.info.videoFormats.filter((f) => fmtHeight(f) === h);
  if (at.length && !at.some((f) => fmtCodec(f) === p.codec)) {
    const c = fmtCodec(at[0]);
    if (c) p.setCodec(c);
  }
}
