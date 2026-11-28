import { describe, expect, it } from "vitest";
import { gradeReport } from "@/lib/mori-proposals.server";

const assess = (grades: number[], weights: number[]) =>
  gradeReport({
    outcomes: grades.map((grade, i) => ({ grade, probability: weights[i] })),
    take: "Keep it raw.",
  });

describe("pre-grade outcomes", () => {
  it.each([
    [
      [9.5, 8],
      [50, 50],
    ],
    [
      [11, 8],
      [50, 50],
    ],
    [
      [0, 8],
      [50, 50],
    ],
    [
      [9, 9],
      [50, 50],
    ],
    [[9], [100]],
    [
      [10, 9, 8, 7, 6],
      [20, 20, 20, 20, 20],
    ],
    [
      [9, 8],
      [0, 0],
    ],
    [
      [9, 8],
      [0.01, 100],
    ],
  ])("rejects invalid grades or outcome counts: %j, %j", (grades, weights) => {
    expect(assess(grades, weights)).toBeNull();
  });
  it.each([
    [
      [33, 33, 33],
      [34, 33, 33],
    ],
    [
      [33.5, 33.5, 33],
      [34, 33, 33],
    ],
    [
      [50, 51, 0],
      [50, 50],
    ],
    [
      [50, 50, 0.01],
      [50, 50],
    ],
  ])("allocates exactly 100 whole points for %j", (weights, expected) => {
    expect(assess([10, 9, 8], weights)?.outcomes.map((o) => o.probability)).toEqual(expected);
  });
});
