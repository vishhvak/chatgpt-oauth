export type ClassValue = string | false | null | undefined;

/** Minimal `cn`, so the example carries no styling dependencies of its own. */
export function cn(...values: ClassValue[]): string {
  return values.filter((value): value is string => typeof value === "string" && value !== "").join(" ");
}
