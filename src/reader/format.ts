const longDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatLongDate(value: string): string {
  return longDate.format(new Date(`${value}T00:00:00Z`));
}

export function formatShortDate(value: string): string {
  return shortDate.format(new Date(`${value}T00:00:00Z`));
}

export function publicationDate(value: string): string {
  return value.slice(0, 10);
}

export function sourceLabel(source: string, author: string): string {
  return author && author !== source ? `${source} · ${author}` : source;
}
