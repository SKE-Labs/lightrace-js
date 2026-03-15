import { randomUUID } from "node:crypto";

/** Generate a unique ID. */
export function generateId(): string {
  return randomUUID();
}

/** Make a value JSON-serializable. */
export function jsonSerializable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSerializable);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = jsonSerializable(v);
    }
    return result;
  }
  return String(value);
}

/** Convert a Zod schema to JSON Schema (basic). */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } };
  if (!s._def) return null;

  // Handle ZodObject
  if (s._def.typeName === "ZodObject" && typeof s._def.shape === "function") {
    const shape = s._def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, field] of Object.entries(shape)) {
      const f = field as { _def?: { typeName?: string; innerType?: unknown } };
      if (!f._def) continue;

      let typeName = f._def.typeName;
      // Unwrap ZodOptional
      if (typeName === "ZodOptional" && f._def.innerType) {
        const inner = f._def.innerType as { _def?: { typeName?: string } };
        typeName = inner._def?.typeName;
      } else {
        required.push(key);
      }

      const typeMap: Record<string, string> = {
        ZodString: "string",
        ZodNumber: "number",
        ZodBoolean: "boolean",
        ZodArray: "array",
        ZodObject: "object",
      };
      properties[key] = { type: typeMap[typeName ?? ""] ?? "string" };
    }

    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length) result.required = required;
    return result;
  }

  return null;
}
