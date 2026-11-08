"use client";

import { AUDIO, MP3_BITRATES } from "./constants";

export function AudioPicker({
  fmt,
  onPick,
  mp3Bitrate,
  onBitrate,
}: {
  fmt: string;
  onPick: (a: string) => void;
  mp3Bitrate: number;
  onBitrate: (b: number) => void;
}) {
  return (
    <>
      <div className="seg-list audio-list">
        {AUDIO.map((a) => (
          <button key={a} className={"seg" + (fmt === a ? " active" : "")} onClick={() => onPick(a)}>
            {a}
          </button>
        ))}
      </div>
      {fmt === "MP3" && (
        <div className="codec-row">
          {MP3_BITRATES.map((b) => (
            <button key={b} className={"chip" + (mp3Bitrate === b ? " active" : "")} onClick={() => onBitrate(b)}>
              {b} kbps
            </button>
          ))}
        </div>
      )}
    </>
  );
}
