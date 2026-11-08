"use client";

import type { PublicFormat, PublicInfo } from "../../../lib/ytdlp";
import type { HistoryEntry } from "../../../hooks/use-downloader";
import { UrlForm } from "./url-form";
import { ErrorCard, IdleHint, SkeletonList } from "./feedback";
import { ReadyView } from "./ready-view";

interface Props {
  url: string;
  setUrl: (u: string) => void;
  phase: "idle" | "loading" | "ready" | "error";
  info: PublicInfo | null;
  errorMsg: string | null;
  errorCode: string | null;
  history: HistoryEntry[];
  onFetch: (u: string) => void;
  onReset: () => void;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
}

export function HomeTab(props: Props) {
  const { phase, info } = props;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" aria-label="Download home">
      <UrlForm url={props.url} setUrl={props.setUrl} onFetch={props.onFetch} loading={phase === "loading"} />

      {phase === "idle" && <IdleHint history={props.history} />}
      {phase === "loading" && <SkeletonList />}
      {phase === "error" && (
        <ErrorCard
          code={props.errorCode || "FETCH_FAILED"}
          msg={props.errorMsg}
          onRetry={() => props.onFetch(props.url)}
        />
      )}
      {phase === "ready" && info && <ReadyView info={info} onStart={props.onStart} onReset={props.onReset} />}
    </section>
  );
}
