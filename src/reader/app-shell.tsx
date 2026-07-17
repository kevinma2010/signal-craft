import { getRouteApi, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, Minus, Monitor, Moon, Plus, Search, Sun, X } from "lucide-react";
import { useMemo, useState } from "react";
import { formatShortDate } from "./format";

const rootRoute = getRouteApi("__root__");
const FONT_STEPS = [0.9, 1, 1.12, 1.24] as const;
type Theme = "system" | "light" | "dark";

function useReaderLibrary() {
  return rootRoute.useLoaderData();
}

export function AppShell() {
  const { digests } = useReaderLibrary();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fontStep, setFontStep] = useState(1);
  const [theme, setTheme] = useState<Theme>("system");
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return digests;
    return digests.filter((digest) =>
      [digest.title, digest.excerpt, digest.kind, digest.date]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [digests, query]);

  function chooseTheme(value: Theme) {
    setTheme(value);
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = value;
  }

  return (
    <div
      className="app-shell"
      data-drawer-open={drawerOpen || undefined}
      style={
        { "--font-scale": FONT_STEPS[fontStep] ?? 1 } as React.CSSProperties
      }
    >
      <aside
        className="archive-panel"
        id="archive-panel"
        aria-label="Archive browser"
      >
        <div className="archive-header">
          <Link
            className="wordmark"
            to="/briefings"
            onClick={() => setDrawerOpen(false)}
          >
            <span className="wordmark-mark" aria-hidden="true">
              S
            </span>
            <span>SignalCraft</span>
          </Link>
          <button
            className="icon-button mobile-only"
            type="button"
            aria-label="Close archive"
            onClick={() => setDrawerOpen(false)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="archive-heading">
          <p className="eyebrow">Library</p>
          <h2 className="text-balance">Briefing archive</h2>
        </div>
        <nav className="archive-switcher" aria-label="Library sections">
          <Link to="/briefings" activeOptions={{ includeSearch: false }}>
            Briefings
          </Link>
          <Link to="/signals" activeOptions={{ includeSearch: false }}>
            Signals
          </Link>
        </nav>
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">Search the archive</span>
          <input
            type="search"
            placeholder="Search briefings"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <div className="archive-results" aria-live="polite">
          {matches.length ? (
            <nav aria-label="Briefings">
              <ol className="archive-list">
                {matches.map((digest) => (
                  <li key={digest.id}>
                    <Link
                      className="archive-link"
                      to="/briefings/$digestId"
                      params={{ digestId: digest.id }}
                      onClick={() => setDrawerOpen(false)}
                    >
                      <span className="archive-link-title">{digest.title}</span>
                      <span className="archive-link-meta tabular-nums">
                        <time dateTime={digest.date}>
                          {formatShortDate(digest.date)}
                        </time>
                        <span>{digest.readingMinutes} min</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </nav>
          ) : (
            <div className="archive-message">
              <strong>
                {query ? "No matching briefings" : "No briefings yet"}
              </strong>
              {query ? (
                <button type="button" onClick={() => setQuery("")}>
                  Clear search
                </button>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close archive"
        hidden={!drawerOpen}
        onClick={() => setDrawerOpen(false)}
      />

      <main className="reader-main" id="main-content">
        <header className="reader-toolbar">
          <div className="toolbar-start">
            <button
              className="icon-button mobile-only"
              type="button"
              aria-label="Open archive"
              aria-controls="archive-panel"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu aria-hidden="true" />
            </button>
            <span className="mobile-wordmark">SignalCraft</span>
          </div>
          <div className="reading-controls">
            <fieldset className="stepper">
              <legend className="sr-only">Text size</legend>
              <button
                type="button"
                aria-label="Decrease text size"
                disabled={fontStep === 0}
                onClick={() => setFontStep((step) => Math.max(0, step - 1))}
              >
                <Minus aria-hidden="true" />
              </button>
              <output className="tabular-nums">
                {Math.round((FONT_STEPS[fontStep] ?? 1) * 100)}%
              </output>
              <button
                type="button"
                aria-label="Increase text size"
                disabled={fontStep === FONT_STEPS.length - 1}
                onClick={() =>
                  setFontStep((step) =>
                    Math.min(FONT_STEPS.length - 1, step + 1),
                  )
                }
              >
                <Plus aria-hidden="true" />
              </button>
            </fieldset>
            <fieldset className="theme-switcher">
              <legend className="sr-only">Color theme</legend>
              {(["system", "light", "dark"] as const).map((value) => {
                const Icon =
                  value === "system" ? Monitor : value === "light" ? Sun : Moon;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`Use ${value} theme`}
                    aria-pressed={theme === value}
                    onClick={() => chooseTheme(value)}
                  >
                    <Icon aria-hidden="true" />
                  </button>
                );
              })}
            </fieldset>
          </div>
        </header>
        <section
          className="reader-surface"
          data-view={
            pathname.startsWith("/signals/")
              ? "item"
              : pathname === "/signals"
                ? "signals"
                : "briefing"
          }
          key={pathname}
        >
          <Outlet />
        </section>
      </main>
    </div>
  );
}
