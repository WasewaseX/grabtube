"use client";

import { useCallback, useState } from "react";
import { useDownloader } from "../../../hooks/use-downloader";
import { UrlCard } from "./url-card";
import { VideoPanel } from "./video-panel";
import { JobsList } from "./jobs-list";

export function Downloader() {
  const dl = useDownloader();
  const [audioMode, setAudioMode] = useState(false);
  const [audioFmt, setAudioFmt] = useState("M4A");
  const [quality, setQuality] = useState("1080p");
  const [codec, setCodec] = useState("H.264 (AVC)");
  const [mp3Bitrate, setMp3Bitrate] = useState(320);

  const analyze = useCallback(() => {
    if (dl.url.trim()) void dl.fetchInfo(dl.url);
  }, [dl]);

  const info = dl.info;
  const loading = dl.phase === "loading";

  return (
    <main className="wrap">
      <UrlCard
        url={dl.url}
        onUrlChange={dl.setUrl}
        onSubmit={analyze}
        loading={loading}
        pendingNote={dl.pendingNote}
        errorMsg={dl.phase === "error" ? dl.errorMsg : null}
      />
      {info && (
        <VideoPanel
          info={info}
          audioMode={audioMode}
          setAudioMode={setAudioMode}
          quality={quality}
          setQuality={setQuality}
          codec={codec}
          setCodec={setCodec}
          audioFmt={audioFmt}
          setAudioFmt={setAudioFmt}
          mp3Bitrate={mp3Bitrate}
          setMp3Bitrate={setMp3Bitrate}
          onStart={(fmt, bitrate) => {
            void dl.startDownload(fmt, info, bitrate);
          }}
          onDirectLink={(fmt, bitrate) => {
            void dl.getDirectLink(fmt, info, bitrate);
          }}
        />
      )}
      <JobsList items={dl.items} onCancel={dl.cancelItem} onRemove={dl.removeItem} onClearFinished={dl.clearFinished} />
    </main>
  );
}
