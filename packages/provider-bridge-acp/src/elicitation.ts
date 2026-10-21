import {
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  userQuestionPendingInteractionPayloadSchema,
  type PendingInteractionUserAnswer,
  type PendingInteractionUserQuestionQuestion,
  type UserQuestionPendingInteractionPayload,
  type UserQuestionPendingInteractionResolution,
} from "@bb/domain";
import { isJsonObject, readString } from "./session/decode.js";
import type { AcpJsonObject } from "./session/session-types.js";

export type AcpElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export type AcpElicitationPlan =
  | {
      kind: "questions";
      payload: UserQuestionPendingInteractionPayload;
      toResponse(
        resolution: UserQuestionPendingInteractionResolution,
      ): AcpElicitationResponse;
    }
  | { kind: "unsupported"; reason: string };

interface AcpElicitationChoice {
  value: string;
  label: string;
}

type AcpElicitationField =
  | { kind: "choice"; choices: AcpElicitationChoice[] }
  | { kind: "typedChoice"; choices: AcpElicitationChoice[] }
  | { kind: "multiChoice"; choices: AcpElicitationChoice[] }
  | { kind: "boolean" }
  | { kind: "text" }
  | { kind: "number"; integer: boolean };

interface PlannedField {
  name: string;
  field: AcpElicitationField;
  otherName?: string;
  question: PendingInteractionUserQuestionQuestion;
}

const CONFIRM_QUESTION_ID = "confirm";
const CONFIRM_ACCEPT_VALUE = "accept";
const CONFIRM_DECLINE_VALUE = "decline";
const OTHER_FIELD_SUFFIX = "__other";

function readChoices(schema: AcpJsonObject): AcpElicitationChoice[] | null {
  const titled = schema["oneOf"] ?? schema["anyOf"];
  if (Array.isArray(titled)) {
    const choices: AcpElicitationChoice[] = [];
    for (const entry of titled) {
      if (!isJsonObject(entry) || typeof entry["const"] !== "string") {
        return null;
      }
      choices.push({
        value: entry["const"],
        label: readString(entry, "title") ?? entry["const"],
      });
    }
    return choices.length > 0 ? choices : null;
  }
  const values = schema["enum"];
  if (!Array.isArray(values)) {
    return null;
  }
  const names = Array.isArray(schema["enumNames"]) ? schema["enumNames"] : [];
  const choices: AcpElicitationChoice[] = [];
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      return;
    }
    const name = names[index];
    choices.push({
      value,
      label: typeof name === "string" && name.trim() !== "" ? name : value,
    });
  });
  return choices.length > 0 ? choices : null;
}

function planField(schema: AcpJsonObject): AcpElicitationField | null {
  const type = readString(schema, "type");
  if (type === "array") {
    const items = schema["items"];
    const choices = isJsonObject(items) ? readChoices(items) : null;
    return choices && choices.length <= USER_QUESTION_MAX_OPTIONS
      ? { kind: "multiChoice", choices }
      : null;
  }
  const choices = readChoices(schema);
  if (choices) {
    return choices.length <= USER_QUESTION_MAX_OPTIONS
      ? { kind: "choice", choices }
      : { kind: "typedChoice", choices };
  }
  switch (type) {
    case "boolean":
      return { kind: "boolean" };
    case "string":
      return { kind: "text" };
    case "number":
      return { kind: "number", integer: false };
    case "integer":
      return { kind: "number", integer: true };
    default:
      return null;
  }
}

function questionFor(
  name: string,
  schema: AcpJsonObject,
  field: AcpElicitationField,
  message: string | undefined,
  hasOther: boolean,
): PendingInteractionUserQuestionQuestion {
  const label = readString(schema, "title")?.trim() || name;
  const description = readString(schema, "description")?.trim();
  const lines = [
    ...(message ? [message, ""] : []),
    label,
    ...(description ? [description] : []),
    ...(field.kind === "typedChoice"
      ? [`One of: ${field.choices.map((choice) => choice.label).join(", ")}`]
      : []),
    ...(field.kind === "number"
      ? [field.integer ? "Enter a whole number." : "Enter a number."]
      : []),
  ];
  const base = {
    id: name,
    prompt: lines.join("\n"),
    shortLabel: label,
  };
  switch (field.kind) {
    case "choice":
      return {
        ...base,
        multiSelect: false,
        options: field.choices,
        allowFreeText: hasOther,
      };
    case "multiChoice":
      return {
        ...base,
        multiSelect: true,
        options: field.choices,
        allowFreeText: hasOther,
      };
    case "boolean":
      return {
        ...base,
        multiSelect: false,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
        allowFreeText: false,
      };
    case "typedChoice":
    case "text":
    case "number":
      return { ...base, multiSelect: false, allowFreeText: true };
  }
}

function decodeAnswer(
  field: AcpElicitationField,
  answer: PendingInteractionUserAnswer | undefined,
): { value: unknown } | null {
  if (!answer) {
    return null;
  }
  const typed = answer.freeText?.trim();
  switch (field.kind) {
    case "choice": {
      const selected = answer.selected[0];
      return field.choices.some((choice) => choice.value === selected)
        ? { value: selected }
        : null;
    }
    case "multiChoice": {
      const allowed = new Set(field.choices.map((choice) => choice.value));
      return answer.selected.every((value) => allowed.has(value))
        ? { value: [...answer.selected] }
        : null;
    }
    case "boolean": {
      const selected = answer.selected[0];
      return selected === "true" || selected === "false"
        ? { value: selected === "true" }
        : null;
    }
    case "typedChoice": {
      if (!typed) {
        return null;
      }
      const wanted = typed.toLowerCase();
      const match = field.choices.find(
        (choice) =>
          choice.value.toLowerCase() === wanted ||
          choice.label.toLowerCase() === wanted,
      );
      return match ? { value: match.value } : null;
    }
    case "text":
      return typed ? { value: typed } : null;
    case "number": {
      if (!typed) {
        return null;
      }
      const parsed = Number(typed);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return field.integer && !Number.isInteger(parsed)
        ? null
        : { value: parsed };
    }
  }
}

function planConfirmation(message: string | undefined): AcpElicitationPlan {
  const payload: UserQuestionPendingInteractionPayload = {
    kind: "user_question",
    questions: [
      {
        id: CONFIRM_QUESTION_ID,
        prompt: message ?? "The agent is asking you to confirm.",
        multiSelect: false,
        options: [
          { value: CONFIRM_ACCEPT_VALUE, label: "Accept" },
          { value: CONFIRM_DECLINE_VALUE, label: "Decline" },
        ],
        allowFreeText: false,
      },
    ],
  };
  return {
    kind: "questions",
    payload,
    toResponse(resolution) {
      return resolution.answers[CONFIRM_QUESTION_ID]?.selected[0] ===
        CONFIRM_ACCEPT_VALUE
        ? { action: "accept", content: {} }
        : { action: "decline" };
    },
  };
}

interface SourceField {
  name: string;
  schema: AcpJsonObject;
  field: AcpElicitationField;
}

function planQuestionFields(
  fields: SourceField[],
  message: string | undefined,
): PlannedField[] {
  const folded = new Set<string>();
  const otherNames = new Map<string, string>();
  for (const entry of fields) {
    if (!entry.name.endsWith(OTHER_FIELD_SUFFIX)) {
      continue;
    }
    const choiceName = entry.name.slice(0, -OTHER_FIELD_SUFFIX.length);
    const choice = fields.find((candidate) => candidate.name === choiceName);
    if (
      entry.field.kind === "text" &&
      choice &&
      (choice.field.kind === "choice" ||
        choice.field.kind === "multiChoice" ||
        choice.field.kind === "typedChoice")
    ) {
      otherNames.set(choiceName, entry.name);
      folded.add(entry.name);
    }
  }
  return fields
    .filter((entry) => !folded.has(entry.name))
    .map((entry, index) => {
      const otherName = otherNames.get(entry.name);
      return {
        name: entry.name,
        field: entry.field,
        otherName,
        question: questionFor(
          entry.name,
          entry.schema,
          entry.field,
          index === 0 ? message : undefined,
          otherName !== undefined,
        ),
      };
    });
}

export function planAcpElicitation(params: unknown): AcpElicitationPlan {
  if (!isJsonObject(params)) {
    return { kind: "unsupported", reason: "the request was malformed" };
  }
  const mode = readString(params, "mode");
  if (mode !== "form") {
    return {
      kind: "unsupported",
      reason: `bb does not offer the "${mode ?? "unknown"}" elicitation mode`,
    };
  }
  const message = readString(params, "message")?.trim() || undefined;
  const schema = params["requestedSchema"];
  const properties = isJsonObject(schema) ? schema["properties"] : undefined;
  const entries = isJsonObject(properties) ? Object.entries(properties) : [];
  if (entries.length === 0) {
    return planConfirmation(message);
  }
  const fields: SourceField[] = [];
  for (const [name, fieldSchema] of entries) {
    const field = isJsonObject(fieldSchema) ? planField(fieldSchema) : null;
    if (name.trim() === "" || !isJsonObject(fieldSchema) || !field) {
      return {
        kind: "unsupported",
        reason: `bb cannot show the field "${name}"`,
      };
    }
    fields.push({ name, schema: fieldSchema, field });
  }
  const planned = planQuestionFields(fields, message);
  if (planned.length > USER_QUESTION_MAX_QUESTIONS) {
    return {
      kind: "unsupported",
      reason: `the form has ${planned.length} fields and bb shows at most ${USER_QUESTION_MAX_QUESTIONS}`,
    };
  }

  const payload = userQuestionPendingInteractionPayloadSchema.safeParse({
    kind: "user_question",
    questions: planned.map((entry) => entry.question),
  });
  if (!payload.success) {
    return { kind: "unsupported", reason: "the form could not be shown" };
  }
  return {
    kind: "questions",
    payload: payload.data,
    toResponse(resolution) {
      const content: Record<string, unknown> = {};
      for (const entry of planned) {
        const answer = resolution.answers[entry.name];
        const decoded = decodeAnswer(entry.field, answer);
        const typed = answer?.freeText?.trim() ?? "";
        if (entry.otherName === undefined) {
          if (!decoded) {
            return { action: "decline" };
          }
          content[entry.name] = decoded.value;
          continue;
        }
        if (entry.field.kind === "typedChoice") {
          if (decoded) {
            content[entry.name] = decoded.value;
          } else if (typed) {
            content[entry.otherName] = typed;
          } else {
            return { action: "decline" };
          }
          continue;
        }
        if (!decoded && !typed) {
          return { action: "decline" };
        }
        if (decoded) {
          content[entry.name] = decoded.value;
        }
        if (typed) {
          content[entry.otherName] = typed;
        }
      }
      return { action: "accept", content };
    },
  };
}
