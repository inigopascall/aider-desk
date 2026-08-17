/**
 * The Milkdown serializer can emit <br /> for line breaks. We never want HTML
 * in the prompt text, so collapse all <br> variants back to real newlines.
 * It also unnecessarily escapes plain punctuation (e.g. `\...?`) during
 * serialization; normalize those back so the prompt text stays clean.
 * Backslashes used for code, paths, commands, or other intentional Markdown
 * escapes are preserved — only the targeted punctuation escapes are collapsed.
 */
export const sanitizeMilkdownMarkdown = (markdown: string): string =>
  markdown
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\([.?!,:;])/g, '$1');
