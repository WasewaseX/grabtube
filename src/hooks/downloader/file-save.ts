type SavePicker = (opts: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

/**
 * Open the File System Access API writable for the chosen target. Returns
 * null when the picker is unavailable (permission/iframe issues, automation)
 * so callers can fall back to the blob path; rethrows AbortError because a
 * user-cancelled dialog must abort the whole download.
 */
export async function openWritable(
  filename: string,
  mime: string,
  ext: string,
): Promise<FileSystemWritableFileStream | null> {
  const w = window as unknown as { showSaveFilePicker?: SavePicker };
  // automation/headless environments can't render the native picker → blob path
  const automated = typeof navigator !== "undefined" && navigator.webdriver === true;
  if (!w.showSaveFilePicker || automated) return null;
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: `${ext.toUpperCase()} file`, accept: { [mime]: [`.${ext}`] } }],
    });
    return await handle.createWritable();
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "AbortError") throw e; // user cancelled → abort whole download
    return null; // permission/iframe issue → blob fallback
  }
}

export function mimeForExt(ext: string): string {
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

/** Click a synthetic <a download> so the browser's download manager takes over. */
export function triggerBrowserDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
