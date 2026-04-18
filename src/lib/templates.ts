/**
 * Render a {{variable}} template with ALL occurrences replaced globally.
 *
 * Previous bug: services were calling String#replace with a plain string,
 * which only replaces the first occurrence. Templates with the same variable
 * referenced twice (e.g. {{parent_name}} in both title and body) leaked
 * literal placeholders into output. Always use this helper.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "");
}

/**
 * Very simple HTML → plaintext conversion for email multipart/alternative.
 *
 * This is intentionally simple and is NOT an HTML parser. Good enough for
 * our transactional templates which are built from controlled MJML output
 * and never contain user-provided HTML.
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      // Drop script and style blocks entirely.
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      // Turn <br>, </p>, </div>, </li> into newlines.
      // Block-level closing tags (</p>, </div>, </h1>…) become \n\n so that
      // consecutive paragraphs produce a blank line between them.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      // Convert links to "text (url)".
      .replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
      // Strip all remaining tags.
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities.
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Collapse runs of whitespace but preserve paragraph breaks.
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
