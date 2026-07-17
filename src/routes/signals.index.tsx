import { createFileRoute, Link } from "@tanstack/react-router";
import { FileText, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { publicationDate, sourceLabel } from "../reader/format";
import { getReaderItems } from "../reader/server";

export const Route = createFileRoute("/signals/")({
  loader: () => getReaderItems(),
  component: SignalCatalog,
});

function SignalCatalog() {
  const items = Route.useLoaderData();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const types = useMemo(
    () => [...new Set(items.map((item) => item.type))].sort(),
    [items],
  );
  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const grouped = new Map<string, typeof items>();
    for (const item of items) {
      if (type !== "all" && item.type !== type) continue;
      if (
        normalized &&
        ![item.title, item.source, item.author, item.excerpt, item.type]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalized)
      )
        continue;
      const date = publicationDate(item.publishedAt);
      grouped.set(date, [...(grouped.get(date) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [items, query, type]);
  const count = groups.reduce((total, [, values]) => total + values.length, 0);

  return (
    <section className="signal-catalog" id="signal-catalog">
      <header className="signal-catalog-header">
        <div>
          <p className="digest-kind">Signal archive</p>
          <h1 className="text-balance">Signals</h1>
        </div>
        <p className="signal-catalog-count tabular-nums">
          {count} {count === 1 ? "signal" : "signals"}
        </p>
      </header>
      <search className="signal-catalog-tools">
        <label className="catalog-search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">Search signals</span>
          <input
            id="signal-catalog-search"
            type="search"
            placeholder="Search signals"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {query ? (
            <button
              className="catalog-search-clear"
              type="button"
              aria-label="Clear signal search"
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <div className="catalog-filter-field">
          <label htmlFor="signal-catalog-type">Type</label>
          <select
            id="signal-catalog-type"
            value={type}
            onChange={(event) => setType(event.currentTarget.value)}
          >
            <option value="all">All types</option>
            {types.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </search>
      <div
        className="signal-catalog-groups"
        id="signal-catalog-groups"
        aria-live="polite"
      >
        {groups.length ? (
          groups.map(([date, values]) => (
            <section className="signal-date-group" key={date}>
              <header className="signal-date-header">
                <h2 className="tabular-nums">{date}</h2>
                <span>{values.length}</span>
              </header>
              <ol className="signal-catalog-list">
                {values.map((item) => (
                  <li key={item.id}>
                    <Link
                      className="signal-catalog-row"
                      to="/signals/$itemId"
                      params={{ itemId: item.id }}
                    >
                      <span className="signal-row-copy">
                        <strong>{item.title}</strong>
                        <span className="signal-row-excerpt">
                          {item.excerpt || "No archived body."}
                        </span>
                      </span>
                      <span className="signal-row-details">
                        <span className="signal-row-source">
                          <FileText aria-hidden="true" />
                          {sourceLabel(item.source, item.author)}
                        </span>
                        <span className="signal-row-labels">
                          <span>{item.type}</span>
                          <span>{item.contentStatus}</span>
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          ))
        ) : (
          <div className="reader-state">
            <h2>No matching signals</h2>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setType("all");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
