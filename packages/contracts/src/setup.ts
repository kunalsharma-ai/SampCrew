import { z } from 'zod';
import { code, countryCode, currencyCode, email, name, timezone } from './schemas/common';

/**
 * First-login company setup. A new workspace's admin is taken through it before adding employees: company details,
 * locations, then departments and designations picked from a ready-made list for their industry (or typed in).
 */

export const INDUSTRIES = [
  'it_services', 'manufacturing', 'retail', 'healthcare', 'staffing', 'financial_services', 'education', 'logistics', 'hospitality', 'construction', 'other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const INDUSTRY_LABELS: Record<Industry, string> = {
  it_services: 'IT and software services', manufacturing: 'Manufacturing', retail: 'Retail', healthcare: 'Healthcare', staffing: 'Staffing and recruitment',
  financial_services: 'Banking and financial services', education: 'Education', logistics: 'Logistics and supply chain', hospitality: 'Hospitality',
  construction: 'Construction and real estate', other: 'Other',
};

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'] as const;

export const SETUP_STEPS = ['Company', 'Locations', 'Departments', 'Designations', 'Finish'] as const;

export interface CatalogueDepartment { name: string; code: string }
export interface CatalogueDesignation { name: string; code: string; level: number }

const COMMON_DEPARTMENTS: CatalogueDepartment[] = [
  { name: 'Management', code: 'MGMT' }, { name: 'Human Resources', code: 'HR' }, { name: 'Finance and Accounts', code: 'FIN' },
  { name: 'Administration', code: 'ADMIN' }, { name: 'Sales', code: 'SALES' }, { name: 'Marketing', code: 'MKT' },
  { name: 'Information Technology', code: 'IT' }, { name: 'Operations', code: 'OPS' },
];

const INDUSTRY_DEPARTMENTS: Record<Industry, CatalogueDepartment[]> = {
  it_services: [{ name: 'Engineering', code: 'ENG' }, { name: 'Quality Assurance', code: 'QA' }, { name: 'Product', code: 'PROD' }, { name: 'Delivery', code: 'DEL' }, { name: 'Customer Support', code: 'SUP' }],
  manufacturing: [{ name: 'Production', code: 'PRD' }, { name: 'Quality Control', code: 'QC' }, { name: 'Maintenance', code: 'MNT' }, { name: 'Stores and Purchase', code: 'PUR' }, { name: 'Health and Safety', code: 'EHS' }],
  retail: [{ name: 'Store Operations', code: 'STORE' }, { name: 'Merchandising', code: 'MERCH' }, { name: 'Supply Chain', code: 'SCM' }, { name: 'Customer Service', code: 'CS' }],
  healthcare: [{ name: 'Clinical Services', code: 'CLIN' }, { name: 'Nursing', code: 'NURS' }, { name: 'Pharmacy', code: 'PHARM' }, { name: 'Laboratory', code: 'LAB' }, { name: 'Patient Services', code: 'PATIENT' }],
  staffing: [{ name: 'Recruitment', code: 'REC' }, { name: 'Client Services', code: 'CLIENT' }, { name: 'Payroll Services', code: 'PAYS' }, { name: 'Compliance', code: 'COMP' }],
  financial_services: [{ name: 'Risk and Compliance', code: 'RISK' }, { name: 'Credit', code: 'CREDIT' }, { name: 'Customer Service', code: 'CS' }, { name: 'Treasury', code: 'TRSY' }],
  education: [{ name: 'Academics', code: 'ACAD' }, { name: 'Admissions', code: 'ADM' }, { name: 'Examinations', code: 'EXAM' }, { name: 'Student Services', code: 'STUD' }],
  logistics: [{ name: 'Warehouse', code: 'WH' }, { name: 'Transport', code: 'TRN' }, { name: 'Fleet', code: 'FLEET' }, { name: 'Customer Service', code: 'CS' }],
  hospitality: [{ name: 'Front Office', code: 'FO' }, { name: 'Housekeeping', code: 'HK' }, { name: 'Food and Beverage', code: 'FNB' }, { name: 'Kitchen', code: 'KIT' }],
  construction: [{ name: 'Projects', code: 'PROJ' }, { name: 'Site Engineering', code: 'SITE' }, { name: 'Procurement', code: 'PROC' }, { name: 'Health and Safety', code: 'EHS' }],
  other: [{ name: 'Customer Service', code: 'CS' }],
};

const COMMON_DESIGNATIONS: CatalogueDesignation[] = [
  { name: 'Director', code: 'DIR', level: 90 }, { name: 'General Manager', code: 'GM', level: 80 }, { name: 'Senior Manager', code: 'SM', level: 70 },
  { name: 'Manager', code: 'MGR', level: 60 }, { name: 'Assistant Manager', code: 'AM', level: 50 }, { name: 'Team Lead', code: 'TL', level: 40 },
  { name: 'Senior Executive', code: 'SE', level: 30 }, { name: 'Executive', code: 'EXE', level: 20 }, { name: 'Associate', code: 'ASSOC', level: 10 },
  { name: 'HR Executive', code: 'HRE', level: 20 }, { name: 'Accountant', code: 'ACCT', level: 20 }, { name: 'Office Assistant', code: 'OA', level: 5 },
  { name: 'Intern', code: 'INT', level: 0 },
];

const INDUSTRY_DESIGNATIONS: Record<Industry, CatalogueDesignation[]> = {
  it_services: [{ name: 'Software Engineer', code: 'SWE', level: 20 }, { name: 'Senior Software Engineer', code: 'SSE', level: 30 }, { name: 'Technical Architect', code: 'ARCH', level: 60 }, { name: 'QA Engineer', code: 'QAE', level: 20 }, { name: 'Project Manager', code: 'PM', level: 60 }, { name: 'Business Analyst', code: 'BA', level: 30 }],
  manufacturing: [{ name: 'Plant Head', code: 'PH', level: 80 }, { name: 'Production Supervisor', code: 'PSUP', level: 30 }, { name: 'Quality Inspector', code: 'QI', level: 20 }, { name: 'Machine Operator', code: 'OPR', level: 10 }, { name: 'Technician', code: 'TECH', level: 10 }, { name: 'Store Keeper', code: 'SK', level: 10 }],
  retail: [{ name: 'Store Manager', code: 'STM', level: 60 }, { name: 'Assistant Store Manager', code: 'ASM', level: 50 }, { name: 'Cashier', code: 'CASH', level: 10 }, { name: 'Sales Associate', code: 'SA', level: 10 }, { name: 'Visual Merchandiser', code: 'VM', level: 20 }],
  healthcare: [{ name: 'Consultant Doctor', code: 'DOC', level: 70 }, { name: 'Resident Doctor', code: 'RMO', level: 50 }, { name: 'Staff Nurse', code: 'SN', level: 20 }, { name: 'Pharmacist', code: 'PHA', level: 20 }, { name: 'Lab Technician', code: 'LT', level: 10 }],
  staffing: [{ name: 'Recruiter', code: 'REC', level: 20 }, { name: 'Senior Recruiter', code: 'SREC', level: 30 }, { name: 'Account Manager', code: 'ACM', level: 50 }, { name: 'Payroll Executive', code: 'PAYE', level: 20 }],
  financial_services: [{ name: 'Relationship Manager', code: 'RM', level: 40 }, { name: 'Credit Analyst', code: 'CA', level: 30 }, { name: 'Branch Manager', code: 'BM', level: 60 }, { name: 'Teller', code: 'TELL', level: 10 }],
  education: [{ name: 'Principal', code: 'PRIN', level: 80 }, { name: 'Professor', code: 'PROF', level: 60 }, { name: 'Teacher', code: 'TCH', level: 30 }, { name: 'Lab Assistant', code: 'LA', level: 10 }],
  logistics: [{ name: 'Warehouse Manager', code: 'WHM', level: 60 }, { name: 'Supervisor', code: 'SUP', level: 30 }, { name: 'Driver', code: 'DRV', level: 10 }, { name: 'Picker / Packer', code: 'PICK', level: 5 }],
  hospitality: [{ name: 'Front Office Manager', code: 'FOM', level: 60 }, { name: 'Chef', code: 'CHEF', level: 40 }, { name: 'Steward', code: 'STW', level: 10 }, { name: 'Housekeeping Attendant', code: 'HKA', level: 5 }],
  construction: [{ name: 'Project Manager', code: 'PM', level: 60 }, { name: 'Site Engineer', code: 'SITEE', level: 30 }, { name: 'Safety Officer', code: 'SO', level: 30 }, { name: 'Foreman', code: 'FORE', level: 20 }],
  other: [],
};

const uniqueBy = <T extends { name: string }>(list: T[]) => {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.name.toLowerCase()) ? false : (seen.add(x.name.toLowerCase()), true)));
};

/** Suggested departments for an industry: the common ones plus the industry's own. */
export function suggestedDepartments(industry: Industry | null | undefined): CatalogueDepartment[] {
  return uniqueBy([...COMMON_DEPARTMENTS, ...(INDUSTRY_DEPARTMENTS[industry ?? 'other'] ?? [])]);
}

/** Suggested designations for an industry, most senior first. */
export function suggestedDesignations(industry: Industry | null | undefined): CatalogueDesignation[] {
  return uniqueBy([...(INDUSTRY_DESIGNATIONS[industry ?? 'other'] ?? []), ...COMMON_DESIGNATIONS]).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const setupCompanyInput = z.object({
  name,
  legalName: optionalText(200),
  industry: z.enum(INDUSTRIES),
  companySize: z.enum(COMPANY_SIZES),
  website: z.string().trim().max(200).regex(/^https?:\/\/\S+$/, 'Start the website with https://').optional(),
  contactEmail: email.optional(),
  contactPhone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number with digits, spaces or +').optional(),
  countryCode,
  currency: currencyCode,
  timezone,
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  registrationNumber: optionalText(64),
  taxId: optionalText(64),
  address: optionalText(500),
});
export type SetupCompanyInput = z.infer<typeof setupCompanyInput>;

/** Departments and designations to add in one go. Names that already exist are skipped, not duplicated. */
export const setupStructureInput = z.object({
  departments: z.array(z.object({ name, code: code.optional() })).max(60).default([]),
  designations: z.array(z.object({ name, code: z.string().trim().max(20).optional(), level: z.number().int().min(0).max(100).optional() })).max(80).default([]),
});
export type SetupStructureInput = z.infer<typeof setupStructureInput>;

export const setupProgressInput = z.object({ step: z.number().int().min(0).max(SETUP_STEPS.length - 1) });
