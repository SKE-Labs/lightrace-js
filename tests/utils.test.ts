import { describe, it, expect } from "vitest";
import { jsonSerializable, zodToJsonSchema } from "../src/utils.js";

describe("jsonSerializable", () => {
  it("passes through primitives", () => {
    expect(jsonSerializable(null)).toBeNull();
    expect(jsonSerializable(undefined)).toBeUndefined();
    expect(jsonSerializable("hello")).toBe("hello");
    expect(jsonSerializable(42)).toBe(42);
    expect(jsonSerializable(true)).toBe(true);
  });

  it("converts Date to ISO string", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(jsonSerializable(date)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("recursively converts arrays", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(jsonSerializable([1, "two", date])).toEqual([1, "two", "2026-01-01T00:00:00.000Z"]);
  });

  it("recursively converts objects", () => {
    const result = jsonSerializable({
      name: "test",
      date: new Date("2026-01-01T00:00:00Z"),
      nested: { count: 3 },
    });
    expect(result).toEqual({
      name: "test",
      date: "2026-01-01T00:00:00.000Z",
      nested: { count: 3 },
    });
  });

  it("converts unknown types to string", () => {
    expect(jsonSerializable(Symbol("test"))).toBe("Symbol(test)");
  });
});

describe("zodToJsonSchema", () => {
  it("returns null for non-Zod values", () => {
    expect(zodToJsonSchema(null)).toBeNull();
    expect(zodToJsonSchema(undefined)).toBeNull();
    expect(zodToJsonSchema("not a schema")).toBeNull();
    expect(zodToJsonSchema({})).toBeNull();
  });

  it("converts a ZodObject with required fields", () => {
    // Minimal mock of a Zod schema shape
    const mockSchema = {
      _def: {
        typeName: "ZodObject",
        shape: () => ({
          name: { _def: { typeName: "ZodString" } },
          count: { _def: { typeName: "ZodNumber" } },
        }),
      },
    };

    const result = zodToJsonSchema(mockSchema);
    expect(result).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name", "count"],
    });
  });

  it("handles optional fields", () => {
    const mockSchema = {
      _def: {
        typeName: "ZodObject",
        shape: () => ({
          required_field: { _def: { typeName: "ZodString" } },
          optional_field: {
            _def: {
              typeName: "ZodOptional",
              innerType: { _def: { typeName: "ZodNumber" } },
            },
          },
        }),
      },
    };

    const result = zodToJsonSchema(mockSchema);
    expect(result).toEqual({
      type: "object",
      properties: {
        required_field: { type: "string" },
        optional_field: { type: "number" },
      },
      required: ["required_field"],
    });
  });

  it("returns null for non-ZodObject types", () => {
    const mockSchema = {
      _def: { typeName: "ZodString" },
    };
    expect(zodToJsonSchema(mockSchema)).toBeNull();
  });
});
