"use client";

import type { PublicFormat } from "../../../lib/ytdlp";
import { fmtCodec, fmtHeight, qualityHeight } from "./format-utils";

export function QualityGrid({
  qualities,
  vids,
  quality,
  onPick,
}: {
  qualities: string[];
  vids: PublicFormat[];
  quality: string;
  onPick: (q: string) => void;
}) {
  return (
    <div className="quality-grid">
      {qualities.map((q) => {
        const h = qualityHeight(q);
        const has = vids.some((f) => fmtHeight(f) === h);
        return (
          <button
            key={q}
            className={"quality-tile" + (quality === q ? " active" : "")}
            onClick={() => onPick(q)}
            disabled={!has}
          >
            {q}
          </button>
        );
      })}
    </div>
  );
}

export function CodecChips({
  codecs,
  codec,
  available,
  onPick,
}: {
  codecs: string[];
  codec: string;
  available: Set<string>;
  onPick: (c: string) => void;
}) {
  return (
    <div className="codec-row">
      {codecs.map((c) => (
        <button
          key={c}
          className={"chip" + (codec === c ? " active" : "")}
          onClick={() => onPick(c)}
          disabled={!available.has(c)}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
