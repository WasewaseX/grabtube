import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "TubeGrab — Fast YouTube Downloader",
  description:
    "Download YouTube videos and audio in any quality and codec through a consumer-grade WARP tunnel with PO-tokens and community proxy fallbacks. Resumable, IDM-compatible direct links. Built for slow and censored networks.",
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground min-h-screen flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster position="bottom-center" />
      </body>
    </html>
  );
}
