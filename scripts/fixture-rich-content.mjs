// Made-up public audit specimens. No native account history is copied here.
export const RICH_MESSAGES = [
  ['headings', '# Parity sample\n\nOne **bold** word, one *italic* word, and `inline()`.\n\n- Alpha\n- Beta'],
  ['code', '```typescript\ntype Layout = "Compact" | "Spacious";\n\ninterface ReportConfig {\n  layout: Layout;\n  sections: string[];\n}\n\nconst config: ReportConfig = {\n  layout: "Compact",\n  sections: ["Summary", "Code sample", "Flowchart"],\n};\n\nconsole.log(`Rendering ${config.sections.length} sections in ${config.layout} mode`);\n```'],
  ['table', '| Item | Count | Note |\n| --- | ---: | --- |\n| Alpha | 1 | A deliberately wide sample column for scrolling |\n| Beta | 2 | Another sample value |'],
  ['math', 'Inline math: $x^2 + 1$.\n\n$$\n\\sum_{i=1}^{3} i = 6\n$$'],
  ['diagram', '## Flowchart\n\n```mermaid\nflowchart TD\nA[Start test] --> B{Pick a layout}\nB -->|Compact| C[Pick sections]\nB -->|Spacious| C\nC --> D[Add notes]\nD --> E[Render report]\n```'],
  ['link', '[Example](https://example.com)'],
  ['actions', 'A disposable message for Reply, reactions, rendered Copy, Select Text and request-ID checks.'],
];
