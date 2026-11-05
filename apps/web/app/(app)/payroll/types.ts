export interface PayrollRun {
  id: string; legalEntityId: string; legalEntityName: string; month: string; periodStart: string; periodEnd: string; payDate: string; currency: string;
  status: string; employeeCount: number; gross: string; deductions: string; reimbursements: string; net: string; employerContributions: string;
  computedAt: string | null; finalisedAt: string | null;
}
export interface PayrollItemRow {
  id: string; employeeId: string; code: string; name: string; departmentName: string | null; status: 'included' | 'on_hold'; holdReason: string | null;
  daysInPeriod: number; employedDays: number; lopDays: string; lopOverride: string | null; lopOverrideReason: string | null; paidDays: string;
  gross: string; deductions: string; reimbursements: string; net: string; employerContributions: string; tds: string; warningCount: number;
}
export interface PayLine { code: string; name: string; kind: 'earning' | 'deduction' | 'employer' | 'reimbursement'; amount: string; taxable?: boolean; explanation: string }
export interface PayrollItemDetail extends PayrollItemRow { taxable: string; lines: PayLine[]; explanation: string[]; warnings: string[]; computedAt: string }
export interface Adjustment { id: string; employeeId: string; employeeName: string; kind: 'earning' | 'deduction'; label: string; amount: string; taxable: boolean; reason: string; createdAt: string }
export interface PayrollRunDetail extends PayrollRun {
  statusNote: string | null; approvalRequestId: string | null; createdBy: string | null; statutoryEffectiveFrom: string | null; lopSource: string | null;
  items: PayrollItemRow[]; adjustments: Adjustment[]; warnings: string[];
  can: { compute: boolean; submit: boolean; cancel: boolean; exportBankFile: boolean };
}
export interface SalaryRow {
  id: string; code: string; name: string; status: string; legalEntityName: string | null; departmentName: string | null;
  salaryId: string | null; effectiveFrom: string | null; annualCtc: string | null; currency: string | null; structureName: string | null; upcomingRevisions: number;
}
export interface SalaryRevision {
  id: string; effectiveFrom: string; annualCtc: string; currency: string; structureId: string; structureName: string; pfEnabled: boolean; esiEnabled: boolean;
  ptEnabled: boolean; tdsEnabled: boolean; employerPfMonthly: string; note: string | null; createdAt: string; createdBy: string | null; usedByPayroll: boolean;
  lines: { code: string; name: string; kind: string; monthly: string }[];
}
export interface Component { id: string; code: string; name: string; kind: 'earning' | 'deduction'; taxable: boolean; prorate: boolean; pfWage: boolean; isBasic: boolean; isSystem: boolean; description: string; archivedAt: string | null; inUse: boolean }
export interface Structure { id: string; name: string; description: string; archivedAt: string | null; employeeCount: number; lines: { componentId: string; code: string; name: string; kind: string; isBasic: boolean; calc: string; value: string }[] }
export interface Slab { upTo: string | null; amount: string; februaryAmount?: string }
export interface StatutorySettings {
  pf: { employeeRatePercent: string; employerRatePercent: string; epsRatePercent: string; wageCeiling: string; restrictToCeiling: boolean };
  esi: { employeeRatePercent: string; employerRatePercent: string; grossCeiling: string };
  pt: { states: Record<string, Slab[]> };
  tds: { regime: 'new'; standardDeduction: string; slabs: { upTo: string | null; ratePercent: string }[]; rebateLimit: string; cessPercent: string; surchargeThreshold: string };
}
export interface StatutoryRow { id: string; legalEntityId: string; legalEntityName: string; effectiveFrom: string; lopSource: string; settings: StatutorySettings; savedAt: string; savedBy: string | null; usedByRun: boolean }
export interface StatutoryResponse { settings: StatutoryRow[]; startingValues: { countryCode: string; settings: StatutorySettings; notice: string } }
export interface ExpenseCategory { id: string; name: string; receiptRequired: boolean; maxPerClaim: string | null; archivedAt: string | null }
export interface ExpenseClaim {
  id: string; employeeId: string; employeeName: string; employeeCode: string; categoryId: string; categoryName: string; spentOn: string; amount: string; currency: string;
  description: string; receiptName: string | null; receiptType: string | null; receiptSize: number | null; status: string; approvalRequestId: string | null;
  payrollRunId: string | null; paidInMonth: string | null; decidedAt: string | null; paidAt: string | null; createdAt: string;
}
export interface PayslipRow { id: string; employeeId: string; code: string; name: string; month: string; payDate: string; legalEntityName: string; currency: string; gross: string; deductions: string; reimbursements: string; net: string }
export interface Payslip {
  id: string; employeeId: string; month: string; periodStart: string; periodEnd: string; payDate: string; currency: string; legalEntityName: string; workspaceName: string; isDemo: boolean;
  code: string; name: string; dateOfJoining: string; designation: string | null; department: string | null; location: string | null;
  daysInPeriod: number; employedDays: number; lopDays: string; paidDays: string; gross: string; deductions: string; reimbursements: string; net: string;
  employerContributions: string; taxable: string; tds: string; lines: PayLine[]; explanation: string[];
  yearToDate: { financialYearFrom: string; gross: string; tds: string; net: string };
}
