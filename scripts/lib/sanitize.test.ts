import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "./sanitize";

describe("htmlToMarkdown", () => {
  test("removes executable content and tracking pixels", () => {
    const markdown = htmlToMarkdown(
      '<h2>Update</h2><script>alert(1)</script><form>secret</form><p>Body</p><a href="javascript:alert(1)">Unsafe</a><img src="pixel.gif" width="1">',
    );
    expect(markdown).toBe("## Update\n\nBody\n\nUnsafe");
  });

  test("preserves images and embedded media as links", () => {
    const markdown = htmlToMarkdown(
      '<img src="/figure.png" alt="Chart"><video title="Demo"><source src="/demo.mp4"></video><iframe src="/embed" title="Talk"></iframe>',
      "https://example.com/posts/1",
    );
    expect(markdown).toContain("![Chart](https://example.com/figure.png)");
    expect(markdown).toContain("[Video: Demo](https://example.com/demo.mp4)");
    expect(markdown).toContain("[Iframe: Talk](https://example.com/embed)");
    expect(markdown).not.toContain("<iframe");
  });
});
