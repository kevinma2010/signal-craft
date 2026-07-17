import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { AppShell } from "../reader/app-shell";
import { getReaderDigests } from "../reader/server";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  loader: () => getReaderDigests(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { name: "description", content: "SignalCraft local briefing reader" },
      { title: "SignalCraft Reader" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  shellComponent: RootDocument,
  component: AppShell,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
