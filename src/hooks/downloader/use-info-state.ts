"use client";

import { useCallback, useState } from "react";

import type { PublicInfo } from "@/lib/ytdlp";
import { fetchVideoInfo } from "./info-phase";
import type { InfoPhase } from "./types";

/** Owns the url/extraction state shown on the home tab. */
export function useInfoState() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<InfoPhase>("idle");
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const fetchInfo = useCallback(
    (rawUrl: string) =>
      fetchVideoInfo(rawUrl, { setPhase, setInfo, setErrorMsg, setErrorCode, setPendingNote }),
    [],
  );

  const reset = useCallback(() => {
    setUrl("");
    setInfo(null);
    setPhase("idle");
    setErrorMsg(null);
    setErrorCode(null);
    setPendingNote(null);
  }, []);

  return { url, setUrl, phase, pendingNote, info, errorMsg, errorCode, fetchInfo, reset };
}
