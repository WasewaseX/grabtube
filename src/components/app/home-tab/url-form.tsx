"use client";

import { ClipboardPaste, Link2, Loader2, Search, X } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useLang } from "../../../hooks/use-lang";

interface UrlFormProps {
  url: string;
  setUrl: (u: string) => void;
  onFetch: (u: string) => void;
  loading: boolean;
}

export function UrlForm({ url, setUrl, onFetch, loading }: UrlFormProps) {
  const { t } = useLang();

  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onFetch(url);
      }}
    >
      <div className="relative flex-1">
        <Link2 className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("placeholder")}
          dir="ltr"
          spellCheck={false}
          aria-label="Video URL"
          className="h-10 rounded-lg bg-card ps-9 pe-9 text-sm"
        />
        {url && (
          <button
            type="button"
            onClick={() => setUrl("")}
            aria-label={t("clear")}
            className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label={t("paste")}
        className="h-10 w-10 shrink-0"
        onClick={async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              setUrl(text);
              onFetch(text);
            }
          } catch {
            /* clipboard denied */
          }
        }}
      >
        <ClipboardPaste className="h-4 w-4" />
      </Button>
      <Button type="submit" disabled={loading || !url.trim()} className="h-10 shrink-0 gap-1.5">
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("fetching")}
          </>
        ) : (
          <>
            <Search className="h-4 w-4" />
            {t("fetch")}
          </>
        )}
      </Button>
    </form>
  );
}
