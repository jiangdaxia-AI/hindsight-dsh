import { describe, expect, it } from "vitest";
import { CHOICE_SOURCE_PREFIX, appliedChoice, llmChoiceKey } from "./fields";

describe("appliedChoice", () => {
  it("reads the pick back out of a resolved model's provenance", () => {
    expect(appliedChoice(`${CHOICE_SOURCE_PREFIX}wb::cn:deepseek-v4.1-flash`)).toBe(
      "wb::cn:deepseek-v4.1-flash"
    );
    expect(appliedChoice(`${CHOICE_SOURCE_PREFIX} token::glm-5.3-flash `)).toBe("token::glm-5.3-flash");
  });

  it("reads nothing out of a model that came from somewhere else", () => {
    // The page compares this with its own pick: an unrecognized provenance must never look like a
    // choice, or every "follow dsh" install would read as a pending change.
    expect(appliedChoice(undefined)).toBeUndefined();
    expect(appliedChoice("")).toBeUndefined();
    expect(appliedChoice("   ")).toBeUndefined();
    expect(appliedChoice("dsh's current model")).toBeUndefined();
    expect(appliedChoice("explicit environment")).toBeUndefined();
    expect(appliedChoice(CHOICE_SOURCE_PREFIX)).toBeUndefined();
    expect(appliedChoice(`${CHOICE_SOURCE_PREFIX}   `)).toBeUndefined();
  });

  it("round-trips what llmChoiceKey writes", () => {
    const key = llmChoiceKey({ route: "token", model: "glm-5.3-flash" });
    expect(appliedChoice(`${CHOICE_SOURCE_PREFIX}${key}`)).toBe(key);
  });
});
