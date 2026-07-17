import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { isNodeError } from "./files";
import { ITEM_TYPES, type NormalizedItem } from "./types";
import { normalizeUrl } from "./url";

const DEFAULT_PORT = 4317;
const DIGEST_ID_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: http: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export interface ReaderArgs {
  data: string;
  port: number;
}

export interface DigestSummary {
  id: string;
  date: string;
  title: string;
  kind: "daily" | "weekly" | "topic" | "briefing";
  excerpt: string;
  wordCount: number;
  readingMinutes: number;
}

export interface Digest extends DigestSummary {
  html: string;
}

export interface ReaderItem {
  id: string;
  type: NormalizedItem["type"];
  source: string;
  author: string;
  title: string;
  url: string;
  publishedAt: string;
  contentLength: number;
  contentStatus: ReaderItemContentStatus;
  originalHtml: string;
  localizedHtml?: string;
  localizedLanguage?: string;
}

export type ReaderItemContentStatus =
  | "complete"
  | "excerpt"
  | "unknown"
  | "archived"
  | "metadata-only";

export interface ReaderItemSummary {
  id: string;
  type: NormalizedItem["type"];
  source: string;
  author: string;
  title: string;
  publishedAt: string;
  excerpt: string;
  contentLength: number;
  contentStatus: ReaderItemContentStatus;
  hasLocalization: boolean;
}

interface ArchivedItemIndex {
  byId: Map<string, NormalizedItem>;
  idByNormalizedUrl: Map<string, string>;
}

export interface ReaderHandlerOptions {
  dataDirectory: string;
  reportError?: (error: unknown) => void;
}

export interface ReaderServerOptions extends ReaderHandlerOptions {
  port: number;
}

export class InvalidDigestIdError extends Error {
  constructor(id: string) {
    super(`Invalid digest id: ${id}`);
    this.name = "InvalidDigestIdError";
  }
}

export class DigestNotFoundError extends Error {
  constructor(id: string) {
    super(`Digest not found: ${id}`);
    this.name = "DigestNotFoundError";
  }
}

export class InvalidItemIdError extends Error {
  constructor(id: string) {
    super(`Invalid item id: ${id}`);
    this.name = "InvalidItemIdError";
  }
}

export class InvalidLanguageError extends Error {
  constructor(language: string) {
    super(`Invalid language: ${language}`);
    this.name = "InvalidLanguageError";
  }
}

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Item not found: ${id}`);
    this.name = "ItemNotFoundError";
  }
}

export function parseReaderArgs(
  argv: readonly string[],
  homeDirectory = homedir(),
): ReaderArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag ||
      !value ||
      !["--data", "--port"].includes(flag) ||
      values.has(flag)
    ) {
      throw new Error("Usage: --data <path> --port <number>");
    }
    values.set(flag, value);
  }

  const portValue = values.get("--port");
  if (portValue && !/^\d+$/.test(portValue)) {
    throw new Error("--port must be an integer");
  }
  const port = portValue ? Number(portValue) : DEFAULT_PORT;
  if (port < 1 || port > 65_535) {
    throw new Error("--port must be between 1 and 65535");
  }

  return {
    data: values.get("--data") ?? join(homeDirectory, ".signalcraft"),
    port,
  };
}

export function isSafeDigestId(id: string): boolean {
  if (!DIGEST_ID_PATTERN.test(id)) return false;
  const [yearValue, monthValue, dayValue] = id.split("-");
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isSafeItemId(id: string): boolean {
  return ITEM_ID_PATTERN.test(id);
}

export function isSafeLanguage(language: string): boolean {
  if (!LANGUAGE_PATTERN.test(language)) return false;
  try {
    return Intl.getCanonicalLocales(language).length === 1;
  } catch {
    return false;
  }
}

export async function listDigests(
  dataDirectory: string,
): Promise<DigestSummary[]> {
  const digestsDirectory = join(dataDirectory, "digests");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(digestsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .filter(isSafeDigestId)
    .sort((left, right) => right.localeCompare(left));
  const digests: DigestSummary[] = [];
  for (const id of ids) {
    try {
      const markdown = await readDigestMarkdown(dataDirectory, id);
      digests.push(createDigestSummary(id, markdown));
    } catch (error) {
      if (!(error instanceof DigestNotFoundError)) throw error;
    }
  }
  return digests;
}

export async function readDigest(
  dataDirectory: string,
  id: string,
  archivedItemIds?: ReadonlyMap<string, string>,
): Promise<Digest> {
  const markdown = await readDigestMarkdown(dataDirectory, id);
  const itemIds =
    archivedItemIds ??
    (await loadArchivedItemIndex(dataDirectory)).idByNormalizedUrl;
  return {
    ...createDigestSummary(id, markdown),
    html: renderDigestMarkdown(markdown, itemIds),
  };
}

export function renderDigestMarkdown(
  markdown: string,
  archivedItemIds: ReadonlyMap<string, string> = new Map(),
): string {
  const tokens = marked.lexer(markdown, { gfm: true });
  while (tokens[0]?.type === "space") tokens.shift();
  if (tokens[0]?.type === "heading" && tokens[0].depth === 1) tokens.shift();
  return renderMarkdown(marked.parser(tokens), archivedItemIds);
}

export async function readItem(
  dataDirectory: string,
  id: string,
  language?: string,
): Promise<ReaderItem> {
  if (!isSafeItemId(id)) throw new InvalidItemIdError(id);
  const canonicalLanguage = language
    ? canonicalizeLanguage(language)
    : undefined;
  const index = await loadArchivedItemIndex(dataDirectory);
  return createReaderItem(dataDirectory, index, id, canonicalLanguage);
}

export async function listItems(
  dataDirectory: string,
  language?: string,
): Promise<ReaderItemSummary[]> {
  const canonicalLanguage = language
    ? canonicalizeLanguage(language)
    : undefined;
  const index = await loadArchivedItemIndex(dataDirectory);
  const translationsDirectory = canonicalLanguage
    ? await safeDataSubdirectory(dataDirectory, ["cache", "translations"])
    : undefined;
  const items = [...index.byId.values()].sort(compareReaderItemsNewestFirst);
  const summaries: ReaderItemSummary[] = [];
  for (const item of items) {
    const hasLocalization =
      translationsDirectory !== undefined && canonicalLanguage !== undefined
        ? (await readRegularFile(
            join(translationsDirectory, `${item.id}.${canonicalLanguage}.md`),
          )) !== undefined
        : false;
    summaries.push({
      id: item.id,
      type: item.type,
      source: item.source,
      author: item.author,
      title: item.title,
      publishedAt: item.published_at,
      excerpt: createExcerpt(markdownToText(item.text), item.title),
      contentLength: item.text.length,
      contentStatus: readerItemContentStatus(item),
      hasLocalization,
    });
  }
  return summaries;
}

function renderItemMarkdown(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false, gfm: true });
  return renderMarkdown(rendered);
}

function renderMarkdown(
  rendered: string,
  archivedItemIds: ReadonlyMap<string, string> = new Map(),
): string {
  return sanitizeHtml(rendered, {
    allowedTags: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "details",
      "div",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "input",
      "li",
      "ol",
      "p",
      "pre",
      "span",
      "strong",
      "sub",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    allowedAttributes: {
      a: ["href", "rel", "target"],
      code: ["class"],
      img: ["alt", "loading", "src", "title"],
      input: ["checked", "disabled", "type"],
      ol: ["start"],
      td: ["align", "colspan", "rowspan"],
      th: ["align", "colspan", "rowspan"],
    },
    allowedClasses: {
      code: [/^language-[a-z0-9_+-]+$/i],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["data", "http", "https"],
    },
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attributes) => {
        const href = safeLink(attributes.href);
        if (!href) return { tagName: "a", attribs: {} };
        const archivedItemId = archivedItemIdForUrl(href, archivedItemIds);
        if (archivedItemId) {
          return {
            tagName: "a",
            attribs: { href: `/signals/${archivedItemId}` },
          };
        }
        if (!/^https?:/i.test(href)) {
          return { tagName: "a", attribs: { href } };
        }
        const attribs: Record<string, string> = {
          href,
          target: "_blank",
          rel: "noopener noreferrer",
        };
        return {
          tagName: "a",
          attribs,
        };
      },
      img: (_tagName, attributes) => {
        const src = safeImageSource(attributes.src);
        if (!src) return { tagName: "span", attribs: {} };
        return {
          tagName: "img",
          attribs: {
            src,
            ...(attributes.alt ? { alt: attributes.alt } : {}),
            ...(attributes.title ? { title: attributes.title } : {}),
            loading: "lazy",
          },
        };
      },
    },
  });
}

export function createReaderHandler(options: ReaderHandlerOptions) {
  const getItemIndex = () => loadArchivedItemIndex(options.dataDirectory);
  return async (request: Request): Promise<Response> => {
    try {
      return await routeReaderRequest(request, {
        ...options,
        getItemIndex,
      });
    } catch (error) {
      options.reportError?.(error);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  };
}

export function createReaderServer(options: ReaderServerOptions) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: createReaderHandler(options),
  });
}

async function readDigestMarkdown(
  dataDirectory: string,
  id: string,
): Promise<string> {
  if (!isSafeDigestId(id)) throw new InvalidDigestIdError(id);
  const path = join(dataDirectory, "digests", `${id}.md`);
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) throw new DigestNotFoundError(id);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      error instanceof DigestNotFoundError ||
      (isNodeError(error) &&
        ["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code ?? ""))
    ) {
      throw new DigestNotFoundError(id);
    }
    throw error;
  }
}

function createDigestSummary(id: string, markdown: string): DigestSummary {
  const heading = marked
    .lexer(markdown)
    .find((token) => token.type === "heading" && token.depth === 1);
  const title =
    heading?.type === "heading" ? markdownInlineToText(heading.text) || id : id;
  const plainText = markdownToText(markdown);
  const cjkPattern =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const cjkCharacters = plainText.match(cjkPattern) ?? [];
  const words =
    plainText
      .replace(cjkPattern, " ")
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  const wordCount = words.length + cjkCharacters.length;
  return {
    id,
    date: id,
    title,
    kind: digestKind(title),
    excerpt: createExcerpt(plainText, title),
    wordCount,
    readingMinutes: Math.max(1, Math.ceil(wordCount / 220)),
  };
}

function markdownInlineToText(markdown: string): string {
  const html = marked.parseInline(markdown, { async: false });
  return decodeHtmlEntities(
    sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }),
  ).trim();
}

function markdownToText(markdown: string): string {
  return decodeHtmlEntities(
    sanitizeHtml(marked.parse(markdown, { async: false, gfm: true }), {
      allowedTags: [],
      allowedAttributes: {},
    }),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function digestKind(title: string): DigestSummary["kind"] {
  if (/\bweekly\b|周报/i.test(title)) return "weekly";
  if (/\btopic\b|主题/i.test(title)) return "topic";
  if (/\bdaily\b|日报/i.test(title)) return "daily";
  return "briefing";
}

function createExcerpt(plainText: string, title: string): string {
  const withoutTitle = plainText.startsWith(title)
    ? plainText.slice(title.length).trim()
    : plainText;
  if (withoutTitle.length <= 180) return withoutTitle;
  return `${withoutTitle.slice(0, 177).trimEnd()}...`;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/gi,
    (entity, decimal: string, hexadecimal: string, named: string) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal)
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return (
        {
          amp: "&",
          apos: "'",
          gt: ">",
          lt: "<",
          quot: '"',
        }[named.toLowerCase()] ?? entity
      );
    },
  );
}

function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^#[^\s]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function safeImageSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(value)) return value;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function archivedItemIdForUrl(
  href: string,
  archivedItemIds: ReadonlyMap<string, string>,
): string | undefined {
  if (!/^https?:/i.test(href)) return undefined;
  try {
    return archivedItemIds.get(normalizeUrl(href));
  } catch {
    return undefined;
  }
}

async function loadArchivedItemIndex(
  dataDirectory: string,
): Promise<ArchivedItemIndex> {
  const index: ArchivedItemIndex = {
    byId: new Map(),
    idByNormalizedUrl: new Map(),
  };
  const itemsDirectory = await safeDataSubdirectory(dataDirectory, ["items"]);
  if (!itemsDirectory) return index;

  let entries: Dirent<string>[];
  try {
    entries = await readdir(itemsDirectory, { withFileTypes: true });
  } catch (error) {
    if (
      isNodeError(error) &&
      ["ENOENT", "ENOTDIR"].includes(error.code ?? "")
    ) {
      return index;
    }
    throw error;
  }

  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();
  for (const filename of filenames) {
    const text = await readRegularFile(join(itemsDirectory, filename));
    if (text === undefined) continue;
    for (const [lineIndex, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid JSONL at ${join(itemsDirectory, filename)}:${lineIndex + 1}`,
          { cause: error },
        );
      }
      const item = normalizedItem(value);
      if (!item || index.byId.has(item.id)) continue;
      index.byId.set(item.id, item);
      const normalized = normalizeUrl(item.url);
      const currentId = index.idByNormalizedUrl.get(normalized);
      if (!currentId || item.id < currentId) {
        index.idByNormalizedUrl.set(normalized, item.id);
      }
    }
  }
  return index;
}

async function createReaderItem(
  dataDirectory: string,
  index: ArchivedItemIndex,
  id: string,
  language?: string,
): Promise<ReaderItem> {
  const archived = index.byId.get(id);
  if (!archived) throw new ItemNotFoundError(id);
  const localizedMarkdown = language
    ? await readTranslationMarkdown(dataDirectory, id, language)
    : undefined;
  return {
    id: archived.id,
    type: archived.type,
    source: archived.source,
    author: archived.author,
    title: archived.title,
    url: archived.url,
    publishedAt: archived.published_at,
    contentLength: archived.text.length,
    contentStatus: readerItemContentStatus(archived),
    originalHtml: renderItemMarkdown(archived.text),
    ...(localizedMarkdown === undefined
      ? {}
      : {
          localizedHtml: renderItemMarkdown(localizedMarkdown),
          localizedLanguage: language,
        }),
  };
}

function normalizedItem(value: unknown): NormalizedItem | undefined {
  if (!isRecord(value) || !isSafeItemId(value.id as string)) return undefined;
  if (
    !ITEM_TYPES.includes(value.type as NormalizedItem["type"]) ||
    ![
      "source",
      "author",
      "title",
      "url",
      "published_at",
      "fetched_at",
      "text",
    ].every((key) => typeof value[key] === "string") ||
    !["native", "deepgram", "none"].includes(
      value.transcript_provider as string,
    ) ||
    !isRecord(value.extra)
  ) {
    return undefined;
  }
  if (
    !isValidDate(value.published_at as string) ||
    !isValidDate(value.fetched_at as string)
  ) {
    return undefined;
  }
  try {
    const url = new URL(value.url as string);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    normalizeUrl(url.toString());
  } catch {
    return undefined;
  }
  return value as unknown as NormalizedItem;
}

function isValidDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function compareReaderItemsNewestFirst(
  left: NormalizedItem,
  right: NormalizedItem,
): number {
  return (
    new Date(right.published_at).getTime() -
      new Date(left.published_at).getTime() || left.id.localeCompare(right.id)
  );
}

function readerItemContentStatus(
  item: NormalizedItem,
): ReaderItemContentStatus {
  const explicit = item.extra.content_status;
  if (
    explicit === "complete" ||
    explicit === "excerpt" ||
    explicit === "unknown"
  ) {
    return explicit;
  }
  return item.text.trim() ? "archived" : "metadata-only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeLanguage(language: string): string {
  if (!isSafeLanguage(language)) throw new InvalidLanguageError(language);
  return Intl.getCanonicalLocales(language)[0] as string;
}

async function readTranslationMarkdown(
  dataDirectory: string,
  id: string,
  language: string,
): Promise<string | undefined> {
  const directory = await safeDataSubdirectory(dataDirectory, [
    "cache",
    "translations",
  ]);
  if (!directory) return undefined;
  return readRegularFile(join(directory, `${id}.${language}.md`));
}

async function safeDataSubdirectory(
  dataDirectory: string,
  segments: readonly string[],
): Promise<string | undefined> {
  try {
    const root = await realpath(dataDirectory);
    const expected = join(root, ...segments);
    return (await realpath(expected)) === expected ? expected : undefined;
  } catch (error) {
    if (
      isNodeError(error) &&
      ["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code ?? "")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      isNodeError(error) &&
      ["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code ?? "")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function routeReaderRequest(
  request: Request,
  options: ReaderHandlerOptions & {
    getItemIndex: () => Promise<ArchivedItemIndex>;
  },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse("Method not allowed", 405, {
      Allow: "GET, HEAD",
    });
  }
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/digests") {
    return request.method === "HEAD"
      ? emptyResponse(200, "application/json; charset=utf-8")
      : jsonResponse({ digests: await listDigests(options.dataDirectory) });
  }
  if (pathname.startsWith("/api/digests/")) {
    let id: string;
    try {
      id = decodeURIComponent(pathname.slice("/api/digests/".length));
    } catch {
      return jsonResponse({ error: "Invalid digest id" }, 400);
    }
    if (!isSafeDigestId(id)) {
      return jsonResponse({ error: "Invalid digest id" }, 400);
    }
    try {
      const digest = await readDigest(
        options.dataDirectory,
        id,
        (await options.getItemIndex()).idByNormalizedUrl,
      );
      return request.method === "HEAD"
        ? emptyResponse(200, "application/json; charset=utf-8")
        : jsonResponse({ digest });
    } catch (error) {
      if (error instanceof DigestNotFoundError) {
        return jsonResponse({ error: "Digest not found" }, 404);
      }
      throw error;
    }
  }
  if (pathname === "/api/items") {
    const requestUrl = new URL(request.url);
    const requestedLanguage = requestUrl.searchParams.get("language");
    if (
      requestUrl.searchParams.has("language") &&
      (!requestedLanguage || !isSafeLanguage(requestedLanguage))
    ) {
      return jsonResponse({ error: "Invalid language" }, 400);
    }
    if (request.method === "HEAD") {
      return emptyResponse(200, "application/json; charset=utf-8");
    }
    return jsonResponse({
      items: await listItems(
        options.dataDirectory,
        requestedLanguage ?? undefined,
      ),
    });
  }
  if (pathname.startsWith("/api/items/")) {
    let id: string;
    try {
      id = decodeURIComponent(pathname.slice("/api/items/".length));
    } catch {
      return jsonResponse({ error: "Invalid item id" }, 400);
    }
    if (!isSafeItemId(id)) {
      return jsonResponse({ error: "Invalid item id" }, 400);
    }
    const requestUrl = new URL(request.url);
    const requestedLanguage = requestUrl.searchParams.get("language");
    if (
      requestUrl.searchParams.has("language") &&
      (!requestedLanguage || !isSafeLanguage(requestedLanguage))
    ) {
      return jsonResponse({ error: "Invalid language" }, 400);
    }
    const language = requestedLanguage
      ? canonicalizeLanguage(requestedLanguage)
      : undefined;
    try {
      const item = await createReaderItem(
        options.dataDirectory,
        await options.getItemIndex(),
        id,
        language,
      );
      return request.method === "HEAD"
        ? emptyResponse(200, "application/json; charset=utf-8")
        : jsonResponse({ item });
    } catch (error) {
      if (error instanceof ItemNotFoundError) {
        return jsonResponse({ error: "Item not found" }, 404);
      }
      throw error;
    }
  }

  return textResponse("Not found", 404);
}

function jsonResponse(value: unknown, status = 200): Response {
  return secureResponse(JSON.stringify(value), status, {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function textResponse(
  value: string,
  status: number,
  headers: HeadersInit = {},
): Response {
  return secureResponse(value, status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
}

function emptyResponse(status: number, contentType: string): Response {
  return secureResponse(null, status, { "Content-Type": contentType });
}

function secureResponse(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit,
): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, ...headers },
  });
}
