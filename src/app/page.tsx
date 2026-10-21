import { DownloaderApp } from "@/components/app/app";

/**
 * YouWee — YouTube Downloader. Single-window shell (topbar, URL card,
 * quality tiles / codec chips / audio segments, live job rows, settings +
 * history overlays). 1:1 port of the original desktop app design. Fully
 * client-rendered after the static shell mounts: every dynamic value
 * arrives via client fetches, so server HTML and first client render
 * always match (hydration-safe).
 */
export default function Home() {
  return <DownloaderApp />;
}
