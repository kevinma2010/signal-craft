/* biome-ignore-all lint/security/noDangerouslySetInnerHtml: The server returns allowlist-sanitized Markdown HTML. */
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { formatLongDate, publicationDate, sourceLabel } from "../reader/format";
import { getReaderItem } from "../reader/server";

type ReadingMode = "bilingual" | "localized" | "original";

export const Route = createFileRoute("/signals/$itemId")({
  loader: ({ params }) =>
    getReaderItem({ data: { id: params.itemId, language: "zh-CN" } }),
  component: ItemView,
});

function ItemView() {
  const item = Route.useLoaderData();
  const [mode, setMode] = useState<ReadingMode>(
    item.localizedHtml ? "bilingual" : "original",
  );
  const showLocalized = Boolean(item.localizedHtml) && mode !== "original";
  const showOriginal = mode !== "localized" || !item.localizedHtml;
  return (
    <article className="item-view">
      <header className="item-header">
        <p className="digest-kind">
          {item.type} · {item.contentStatus}
        </p>
        <h1 className="text-balance">{item.title}</h1>
        <div className="item-meta">
          <span>{sourceLabel(item.source, item.author)}</span>
          <time dateTime={item.publishedAt}>
            {formatLongDate(publicationDate(item.publishedAt))}
          </time>
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            Open source <ExternalLink aria-hidden="true" />
          </a>
        </div>
        {item.localizedHtml ? (
          <fieldset className="reading-mode-switcher">
            <legend className="sr-only">Reading mode</legend>
            {(["bilingual", "localized", "original"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value}
              </button>
            ))}
          </fieldset>
        ) : null}
      </header>
      <div
        className={`item-content ${showLocalized && showOriginal ? "is-bilingual" : ""}`}
      >
        {showLocalized ? (
          <section className="item-language-panel">
            <h2>Localized · {item.localizedLanguage}</h2>
            <div
              className="digest-body text-pretty"
              dangerouslySetInnerHTML={{ __html: item.localizedHtml ?? "" }}
            />
          </section>
        ) : null}
        {showOriginal ? (
          <section className="item-language-panel">
            <h2>Original</h2>
            <div
              className="digest-body text-pretty"
              dangerouslySetInnerHTML={{ __html: item.originalHtml }}
            />
          </section>
        ) : null}
      </div>
    </article>
  );
}
