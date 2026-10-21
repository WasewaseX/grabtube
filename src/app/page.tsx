import { DownloaderApp } from "@/components/app/app";

/**
 * TubeGrab — desktop-style single-window shell (title bar, tab strip,
 * Home / Downloads / History / Settings). Fully client-rendered after the
 * static shell mounts: every dynamic value arrives via client fetches, so
 * server HTML and first client render always match (hydration-safe).
 */
export default function Home() {
  return <DownloaderApp initialLang="en" />;
}
