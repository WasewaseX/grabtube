"use client";

import type { PublicInfo } from "../../../lib/ytdlp";
import { fmtDuration } from "./format-utils";

export function VideoHead({ info }: { info: PublicInfo }) {
  return (
    <div className="video-head">
      <div className="thumb">
        <img src={info.thumbnail} alt={info.title} />
      </div>
      <div className="vp-info">
        <div className="vp-title">{info.title}</div>
        <div className="vp-sub">
          {info.author} · {fmtDuration(info.duration)}
          {info.views ? ` · ${info.views.toLocaleString("en-US")} views` : ""}
        </div>
      </div>
    </div>
  );
}
