/**
 * String predicates shared by the preflight implementations.
 */

/**
 * Zod-refine predicate shared by the preflight input schemas: rejects blank
 * strings (empty or whitespace-only) without altering the value.
 */
export function nonBlank(value: string): boolean {
  return value.trim() !== "";
}
