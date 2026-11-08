import { toast } from "sonner";

export function copyDirectLink(directLink: string, directReady: boolean): void {
  const abs = `${window.location.origin}${directLink}`;
  void navigator.clipboard?.writeText(abs).catch(() => undefined);
  if (directReady) {
    toast.success("Direct link copied", {
      description: "The file is stored on the YouWee server — this link downloads it from here with full resume support (IDM, aria2, any browser).",
    });
  } else {
    toast.info("Fetch-first link copied", {
      description: "The server downloads the file first; your download manager will retry automatically and land on the finished file.",
    });
  }
}
