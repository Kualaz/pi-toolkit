export type FooterPlacement = "disabled" | "left" | "right";

export const FOOTER_PLACEMENTS: FooterPlacement[] = ["disabled", "left", "right"];

export type FooterFieldGroup = "location" | "metrics" | "statuses";

export type FooterFieldId =
  | "cwd"
  | "gitBranch"
  | "sessionName"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cost"
  | "contextUsage"
  | "provider"
  | "model"
  | "thinking"
  | "extensionStatuses";

export interface FooterFieldDefinition {
  id: FooterFieldId;
  label: string;
  group: FooterFieldGroup;
  description: string;
}

export const FIELD_DEFINITIONS: FooterFieldDefinition[] = [
  {
    id: "cwd",
    label: "Working directory",
    group: "location",
    description: "Current session working directory, with your home directory shortened to ~.",
  },
  {
    id: "gitBranch",
    label: "Git branch",
    group: "location",
    description: "Current Git branch when the working directory is inside a repository.",
  },
  {
    id: "sessionName",
    label: "Session name",
    group: "location",
    description: "User-defined session display name, if one is set.",
  },
  {
    id: "inputTokens",
    label: "Input tokens",
    group: "metrics",
    description: "Cumulative non-cached input tokens, shown as ↑.",
  },
  {
    id: "outputTokens",
    label: "Output tokens",
    group: "metrics",
    description: "Cumulative output tokens, shown as ↓.",
  },
  {
    id: "cacheReadTokens",
    label: "Cache read tokens",
    group: "metrics",
    description: "Cumulative prompt-cache read tokens, shown as R.",
  },
  {
    id: "cacheWriteTokens",
    label: "Cache write tokens",
    group: "metrics",
    description: "Cumulative prompt-cache write tokens, shown as W.",
  },
  {
    id: "cost",
    label: "Cost / subscription",
    group: "metrics",
    description: "Cumulative cost. Shows (sub) when the active model uses OAuth/subscription auth.",
  },
  {
    id: "contextUsage",
    label: "Context usage",
    group: "metrics",
    description: "Current context-window usage, e.g. 11.0%/400k (auto).",
  },
  {
    id: "provider",
    label: "Provider",
    group: "metrics",
    description: "Current model provider, e.g. (openai-codex).",
  },
  {
    id: "model",
    label: "Model",
    group: "metrics",
    description: "Current model id, e.g. gpt-5.5.",
  },
  {
    id: "thinking",
    label: "Thinking level",
    group: "metrics",
    description: "Current reasoning/thinking level when the model supports reasoning.",
  },
  {
    id: "extensionStatuses",
    label: "Extension statuses",
    group: "statuses",
    description: "Footer statuses published by extensions via ctx.ui.setStatus().",
  },
];

export type FooterFieldConfig = Record<FooterFieldId, FooterPlacement>;

export interface FooterConfig {
  fields: FooterFieldConfig;
}

export const DEFAULT_FIELDS: FooterFieldConfig = {
  cwd: "left",
  gitBranch: "left",
  sessionName: "left",
  inputTokens: "left",
  outputTokens: "left",
  cacheReadTokens: "left",
  cacheWriteTokens: "left",
  cost: "left",
  contextUsage: "left",
  provider: "right",
  model: "right",
  thinking: "right",
  extensionStatuses: "left",
};

export const DEFAULT_CONFIG: FooterConfig = {
  fields: { ...DEFAULT_FIELDS },
};

export function isFooterPlacement(value: string): value is FooterPlacement {
  return (FOOTER_PLACEMENTS as string[]).includes(value);
}

export function getFieldDefinition(id: string): FooterFieldDefinition | undefined {
  return FIELD_DEFINITIONS.find((field) => field.id === id);
}

export function normalizeConfig(input: unknown): FooterConfig {
  const maybeConfig = input && typeof input === "object" ? (input as Partial<FooterConfig>) : {};
  const maybeFields =
    maybeConfig.fields && typeof maybeConfig.fields === "object"
      ? (maybeConfig.fields as Partial<Record<FooterFieldId, unknown>>)
      : {};

  const fields: FooterFieldConfig = { ...DEFAULT_FIELDS };
  for (const field of FIELD_DEFINITIONS) {
    const value = maybeFields[field.id];
    if (typeof value === "string" && isFooterPlacement(value)) {
      fields[field.id] = value;
    }
  }

  return { fields };
}
