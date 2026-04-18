import { describe, it, expect } from "vitest";
import { renderTemplate, htmlToPlainText } from "../../src/lib/templates.js";

describe("renderTemplate", () => {
  it("replaces a single variable", () => {
    expect(renderTemplate("Hi {{name}}", { name: "Maria" })).toBe("Hi Maria");
  });

  // Regression test for P0.3: Billy's googleDocs.ts was using
  // String#replace with a plain string, which only replaces the first
  // occurrence. Templates with variables referenced twice leaked literal
  // {{placeholder}} into the rendered output.
  it("replaces ALL occurrences of a variable (P0.3 regression)", () => {
    const tpl = "Call with {{parent_name}} — Parent Name: {{parent_name}}";
    expect(renderTemplate(tpl, { parent_name: "Maria Garcia" })).toBe(
      "Call with Maria Garcia — Parent Name: Maria Garcia",
    );
  });

  it("replaces multiple different variables each appearing multiple times", () => {
    const tpl = "{{a}} {{b}} {{a}} {{b}} {{a}}";
    expect(renderTemplate(tpl, { a: "X", b: "Y" })).toBe("X Y X Y X");
  });

  it("renders missing variables as empty string", () => {
    expect(renderTemplate("Hi {{missing}}", {})).toBe("Hi ");
  });

  it("handles templates with no variables", () => {
    expect(renderTemplate("no variables here", {})).toBe("no variables here");
  });

  it("doesn't break on variable names with underscores or digits", () => {
    expect(
      renderTemplate("{{parent_1}} {{child_2}}", { parent_1: "A", child_2: "B" }),
    ).toBe("A B");
  });
});

describe("htmlToPlainText", () => {
  it("strips tags", () => {
    expect(htmlToPlainText("<p>Hello</p>")).toBe("Hello");
  });

  it("converts <br> to newlines", () => {
    expect(htmlToPlainText("line1<br>line2")).toBe("line1\nline2");
  });

  it("drops script blocks entirely", () => {
    expect(htmlToPlainText("before<script>alert(1)</script>after")).toBe("beforeafter");
  });

  it("drops style blocks entirely", () => {
    expect(htmlToPlainText("x<style>body{color:red}</style>y")).toBe("xy");
  });

  it("converts anchor tags to text + (url) form", () => {
    expect(htmlToPlainText('<a href="https://example.com">click</a>')).toBe(
      "click (https://example.com)",
    );
  });

  it("decodes common HTML entities", () => {
    expect(htmlToPlainText("&nbsp;&amp;&lt;&gt;&quot;&#39;")).toBe("&<>\"'");
  });

  it("collapses runs of whitespace but preserves paragraph breaks", () => {
    expect(htmlToPlainText("<p>a</p><p>b</p><p>c</p>")).toBe("a\n\nb\n\nc");
  });
});
