import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const REMOVED_ELEMENTS = "script, style, form, noscript, template";
const MEDIA_ELEMENTS: (keyof HTMLElementTagNameMap)[] = [
  "video",
  "audio",
  "iframe",
];

export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const { document } = parseHTML(
    `<!doctype html><html><body>${html}</body></html>`,
  );
  const body = document.body;

  for (const element of body.querySelectorAll(REMOVED_ELEMENTS)) {
    element.remove();
  }

  for (const image of body.querySelectorAll("img")) {
    if (isTrackingPixel(image)) {
      image.remove();
      continue;
    }
    resolveAttribute(image, "src", baseUrl);
  }

  for (const element of body.querySelectorAll(
    "a, video, audio, iframe, source",
  )) {
    resolveAttribute(
      element,
      element.localName === "a" ? "href" : "src",
      baseUrl,
    );
  }

  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });

  turndown.addRule("media-links", {
    filter: MEDIA_ELEMENTS,
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const type = capitalize(element.localName);
      const source =
        element.getAttribute("src") ??
        element.querySelector("source")?.getAttribute("src");
      if (!source) {
        return "";
      }
      const title = element.getAttribute("title")?.trim() || type;
      return `\n\n[${type}: ${title}](${source})\n\n`;
    },
  });

  return turndown
    .turndown(body.innerHTML)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTrackingPixel(image: Element): boolean {
  const width = Number.parseInt(image.getAttribute("width") ?? "", 10);
  const height = Number.parseInt(image.getAttribute("height") ?? "", 10);
  const style =
    image.getAttribute("style")?.replace(/\s/g, "").toLowerCase() ?? "";
  return (
    (Number.isFinite(width) && width <= 1) ||
    (Number.isFinite(height) && height <= 1) ||
    style.includes("display:none") ||
    style.includes("visibility:hidden")
  );
}

function resolveAttribute(
  element: Element,
  name: string,
  baseUrl?: string,
): void {
  const value = element.getAttribute(name);
  if (!value) {
    return;
  }
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    const allowedProtocols =
      name === "href" ? ["http:", "https:", "mailto:"] : ["http:", "https:"];
    if (!allowedProtocols.includes(url.protocol)) {
      element.removeAttribute(name);
      return;
    }
    element.setAttribute(name, url.toString());
  } catch {
    if (baseUrl || value.trim().startsWith("//")) {
      element.removeAttribute(name);
    }
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
