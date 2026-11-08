export function isYouTubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(url.trim())
}

export function isValidYouTubeUrl(url: string): boolean {
  return isYouTubeUrl(url)
}

export function extractVideoId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/shorts\/([\w-]{11})/) ||
    url.match(/embed\/([\w-]{11})/) ||
    url.match(/live\/([\w-]{11})/)
  return m ? m[1] : null
}
