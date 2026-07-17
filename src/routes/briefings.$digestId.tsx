/* biome-ignore-all lint/security/noDangerouslySetInnerHtml: The server returns allowlist-sanitized Markdown HTML. */
import { createFileRoute } from "@tanstack/react-router";
import { formatLongDate } from "../reader/format";
import { getReaderDigest } from "../reader/server";

export const Route = createFileRoute("/briefings/$digestId")({
  loader: ({ params }) => getReaderDigest({ data: params.digestId }),
  component: DigestView,
});

function DigestView() {
  const digest = Route.useLoaderData();
  return (
    <article className="digest">
      <header className="digest-header">
        <p className="digest-kind">{digest.kind} briefing</p>
        <h1 className="text-balance">{digest.title}</h1>
        <div className="digest-meta tabular-nums">
          <time dateTime={digest.date}>{formatLongDate(digest.date)}</time>
          <span>{digest.readingMinutes} min read</span>
          <span>{digest.wordCount.toLocaleString()} words</span>
        </div>
      </header>
      <div
        className="digest-body text-pretty"
        dangerouslySetInnerHTML={{ __html: digest.html }}
      />
    </article>
  );
}
