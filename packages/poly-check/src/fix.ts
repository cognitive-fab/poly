// `poly fix <id>` (PT12.1, S69, S70). Built in plan-m2 step 4; until then no report carries a fix.
export interface FixResult { status: 'applied' | 'refused'; file?: string; code?: string; message: string }

export function applyFixById(report: unknown, id: string): FixResult {
  void report;
  return { status: 'refused', message: `no fix ${id} in the report` };
}
