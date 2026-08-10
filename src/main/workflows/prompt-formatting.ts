export interface PromptSection {
  title: string;
  body: string;
}

export function formatPromptSection(title: string, body: string): string {
  const trimmed = body.trim();
  return `=== ${title} ===\n${trimmed}\n=== END ${title} ===`;
}

export function buildPrompt(sections: PromptSection[]): string {
  return sections
    .filter((section) => section.body.trim().length > 0)
    .map((section) => formatPromptSection(section.title, section.body))
    .join('\n\n');
}
