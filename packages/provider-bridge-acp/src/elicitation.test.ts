import { describe, expect, it } from "vitest";
import { planAcpElicitation } from "./elicitation.js";

function form(properties: Record<string, unknown>, message = "Pick a plan") {
  return {
    sessionId: "s1",
    mode: "form",
    message,
    requestedSchema: { type: "object", properties },
  };
}

function questions(plan: ReturnType<typeof planAcpElicitation>) {
  if (plan.kind !== "questions") {
    throw new Error(`expected questions, got ${JSON.stringify(plan)}`);
  }
  return plan;
}

describe("planAcpElicitation", () => {
  it("turns each field kind into a question and decodes the answers back to typed content", () => {
    const plan = questions(
      planAcpElicitation(
        form({
          strategy: {
            type: "string",
            title: "Strategy",
            description: "How far to go",
            enum: ["conservative", "balanced", "aggressive"],
          },
          targets: {
            type: "array",
            items: {
              anyOf: [
                { const: "web", title: "Web app" },
                { const: "cli", title: "CLI" },
              ],
            },
          },
          dryRun: { type: "boolean" },
          retries: { type: "integer", title: "Retries" },
        }),
      ),
    );

    expect(plan.payload.questions).toEqual([
      {
        id: "strategy",
        prompt: "Pick a plan\n\nStrategy\nHow far to go",
        shortLabel: "Strategy",
        multiSelect: false,
        options: [
          { value: "conservative", label: "conservative" },
          { value: "balanced", label: "balanced" },
          { value: "aggressive", label: "aggressive" },
        ],
        allowFreeText: false,
      },
      {
        id: "targets",
        prompt: "targets",
        shortLabel: "targets",
        multiSelect: true,
        options: [
          { value: "web", label: "Web app" },
          { value: "cli", label: "CLI" },
        ],
        allowFreeText: false,
      },
      {
        id: "dryRun",
        prompt: "dryRun",
        shortLabel: "dryRun",
        multiSelect: false,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
        allowFreeText: false,
      },
      {
        id: "retries",
        prompt: "Retries\nEnter a whole number.",
        shortLabel: "Retries",
        multiSelect: false,
        allowFreeText: true,
      },
    ]);

    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: {
          strategy: { selected: ["balanced"] },
          targets: { selected: ["web", "cli"] },
          dryRun: { selected: ["false"] },
          retries: { selected: [], freeText: " 3 " },
        },
      }),
    ).toEqual({
      action: "accept",
      content: {
        strategy: "balanced",
        targets: ["web", "cli"],
        dryRun: false,
        retries: 3,
      },
    });
  });

  it("declines when an answer does not fit its field", () => {
    const plan = questions(
      planAcpElicitation(form({ retries: { type: "integer" } })),
    );
    for (const freeText of ["many", "2.5"]) {
      expect(
        plan.toResponse({
          kind: "user_answer",
          answers: { retries: { selected: [], freeText } },
        }),
      ).toEqual({ action: "decline" });
    }
    expect(plan.toResponse({ kind: "user_answer", answers: {} })).toEqual({
      action: "decline",
    });
  });

  it("asks for a typed answer when a choice has more options than the card can list, and matches it by value or label", () => {
    const plan = questions(
      planAcpElicitation(
        form({
          branch: {
            type: "string",
            oneOf: ["main", "dev", "release", "hotfix", "next"].map(
              (value) => ({ const: value, title: value.toUpperCase() }),
            ),
          },
        }),
      ),
    );
    expect(plan.payload.questions[0]).toMatchObject({
      allowFreeText: true,
      prompt: "Pick a plan\n\nbranch\nOne of: MAIN, DEV, RELEASE, HOTFIX, NEXT",
    });
    expect(plan.payload.questions[0]?.options).toBeUndefined();
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { branch: { selected: [], freeText: "Hotfix" } },
      }),
    ).toEqual({ action: "accept", content: { branch: "hotfix" } });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { branch: { selected: [], freeText: "staging" } },
      }),
    ).toEqual({ action: "decline" });
  });

  it("folds a choice's Other text field into the same question", () => {
    const plan = questions(
      planAcpElicitation(
        form({
          plan: {
            type: "string",
            oneOf: [
              { const: "alpha", title: "Alpha" },
              { const: "beta", title: "Beta" },
            ],
          },
          plan__other: { type: "string", title: "Other" },
        }),
      ),
    );
    expect(plan.payload.questions).toMatchObject([
      {
        id: "plan",
        multiSelect: false,
        allowFreeText: true,
        options: [{ label: "Alpha" }, { label: "Beta" }],
      },
    ]);
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { plan: { selected: ["alpha"] } },
      }),
    ).toEqual({ action: "accept", content: { plan: "alpha" } });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { plan: { selected: [], freeText: "Gamma" } },
      }),
    ).toEqual({ action: "accept", content: { plan__other: "Gamma" } });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { plan: { selected: ["beta"], freeText: " Gamma " } },
      }),
    ).toEqual({
      action: "accept",
      content: { plan: "beta", plan__other: "Gamma" },
    });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { plan: { selected: [], freeText: "   " } },
      }),
    ).toEqual({ action: "decline" });
  });

  it("folds an Other text field into a multi-select question", () => {
    const plan = questions(
      planAcpElicitation(
        form({
          tags: {
            type: "array",
            items: {
              anyOf: [
                { const: "a", title: "A" },
                { const: "b", title: "B" },
              ],
            },
          },
          tags__other: { type: "string" },
        }),
      ),
    );
    expect(plan.payload.questions).toMatchObject([
      { id: "tags", multiSelect: true, allowFreeText: true },
    ]);
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { tags: { selected: ["a", "b"] } },
      }),
    ).toEqual({ action: "accept", content: { tags: ["a", "b"] } });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { tags: { selected: [], freeText: "Zeta" } },
      }),
    ).toEqual({
      action: "accept",
      content: { tags: [], tags__other: "Zeta" },
    });
  });

  it("folds an Other text field into a typed choice as one free-text question", () => {
    const plan = questions(
      planAcpElicitation(
        form({
          branch: {
            type: "string",
            oneOf: ["main", "dev", "release", "hotfix", "next"].map(
              (value) => ({ const: value, title: value.toUpperCase() }),
            ),
          },
          branch__other: { type: "string" },
        }),
      ),
    );
    expect(plan.payload.questions).toHaveLength(1);
    expect(plan.payload.questions[0]).toMatchObject({
      id: "branch",
      allowFreeText: true,
    });
    expect(plan.payload.questions[0]?.options).toBeUndefined();
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { branch: { selected: [], freeText: "Hotfix" } },
      }),
    ).toEqual({ action: "accept", content: { branch: "hotfix" } });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { branch: { selected: [], freeText: "staging" } },
      }),
    ).toEqual({ action: "accept", content: { branch__other: "staging" } });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { branch: { selected: [], freeText: "  " } },
      }),
    ).toEqual({ action: "decline" });
  });

  it("counts each choice with its Other text field as one question toward the limit", () => {
    const plan = questions(
      planAcpElicitation(
        form({
          a: { type: "string", enum: ["x", "y"] },
          a__other: { type: "string" },
          b: { type: "string", enum: ["x", "y"] },
          b__other: { type: "string" },
          c: { type: "string", enum: ["x", "y"] },
          c__other: { type: "string" },
        }),
      ),
    );
    expect(plan.payload.questions.map((question) => question.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps a text field's companion field as its own question", () => {
    const plan = questions(
      planAcpElicitation(
        form({ notes: { type: "string" }, notes__other: { type: "string" } }),
      ),
    );
    expect(plan.payload.questions.map((question) => question.id)).toEqual([
      "notes",
      "notes__other",
    ]);
  });

  it("shows a form without fields as accept or decline", () => {
    const plan = questions(planAcpElicitation(form({}, "Deploy now?")));
    expect(plan.payload.questions).toMatchObject([
      {
        prompt: "Deploy now?",
        options: [{ label: "Accept" }, { label: "Decline" }],
      },
    ]);
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { confirm: { selected: ["accept"] } },
      }),
    ).toEqual({ action: "accept", content: {} });
    expect(
      plan.toResponse({
        kind: "user_answer",
        answers: { confirm: { selected: ["decline"] } },
      }),
    ).toEqual({ action: "decline" });
  });

  it("refuses forms it cannot show, with the reason", () => {
    expect(
      planAcpElicitation({ mode: "url", url: "https://example.com" }),
    ).toEqual({
      kind: "unsupported",
      reason: 'bb does not offer the "url" elicitation mode',
    });
    expect(
      planAcpElicitation(
        form(
          Object.fromEntries(
            ["a", "b", "c", "d", "e"].map((name) => [name, { type: "string" }]),
          ),
        ),
      ),
    ).toEqual({
      kind: "unsupported",
      reason: "the form has 5 fields and bb shows at most 4",
    });
    expect(planAcpElicitation(form({ nested: { type: "object" } }))).toEqual({
      kind: "unsupported",
      reason: 'bb cannot show the field "nested"',
    });
  });
});
