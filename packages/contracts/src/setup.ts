import { z } from 'zod';
import { LOCATION_TRACKING, officeIpsInput } from './company-profile';
import { phoneNumber } from './phone';
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

const d = (name: string, code: string, level: number): CatalogueDesignation => ({ name, code, level });

/** The everyday titles setup ticks for every new workspace. */
const CORE_DESIGNATIONS = ['Director', 'General Manager', 'Senior Manager', 'Manager', 'Assistant Manager', 'Team Lead', 'Senior Executive', 'Executive', 'Associate', 'HR Executive', 'Accountant', 'Office Assistant', 'Intern'];

/** Titles found in most companies, across management and every common function. */
const COMMON_DESIGNATIONS: CatalogueDesignation[] = [
  // Leadership and management
  d('Chief Executive Officer', 'CEO', 100), d('Managing Director', 'MD', 100), d('Chief Operating Officer', 'COO', 95), d('Chief Financial Officer', 'CFO', 95),
  d('Chief Technology Officer', 'CTO', 95), d('Chief Human Resources Officer', 'CHRO', 95), d('Chief Marketing Officer', 'CMO', 95), d('Vice President', 'VP', 90),
  d('Director', 'DIR', 90), d('Associate Director', 'AD', 85), d('General Manager', 'GM', 80), d('Deputy General Manager', 'DGM', 75),
  d('Senior Manager', 'SM', 70), d('Manager', 'MGR', 60), d('Deputy Manager', 'DM', 55), d('Assistant Manager', 'AM', 50),
  d('Team Lead', 'TL', 40), d('Supervisor', 'SUPV', 30), d('Senior Executive', 'SE', 30), d('Executive', 'EXE', 20),
  d('Senior Associate', 'SASSOC', 20), d('Associate', 'ASSOC', 10), d('Trainee', 'TRN', 5), d('Apprentice', 'APPR', 0), d('Intern', 'INT', 0), d('Consultant', 'CONS', 40),
  // Human resources
  d('HR Director', 'HRD', 90), d('HR Manager', 'HRM', 60), d('HR Business Partner', 'HRBP', 50), d('HR Generalist', 'HRG', 30), d('HR Executive', 'HRE', 20),
  d('Talent Acquisition Specialist', 'TAS', 30), d('Payroll Specialist', 'PAYS', 30), d('Learning and Development Manager', 'LDM', 60),
  // Finance and accounts
  d('Finance Manager', 'FINM', 60), d('Financial Controller', 'FC', 70), d('Chartered Accountant', 'CA', 50), d('Senior Accountant', 'SACCT', 30), d('Accountant', 'ACCT', 20),
  d('Accounts Executive', 'ACCE', 20), d('Accounts Assistant', 'ACCA', 10), d('Financial Analyst', 'FA', 30), d('Tax Manager', 'TAXM', 60), d('Internal Auditor', 'IAUD', 40),
  // Sales, marketing and customer service
  d('Sales Director', 'SD', 90), d('Sales Manager', 'SALM', 60), d('Area Sales Manager', 'ASLM', 50), d('Key Account Manager', 'KAM', 50), d('Business Development Manager', 'BDM', 50),
  d('Business Development Executive', 'BDE', 20), d('Sales Executive', 'SALE', 20), d('Marketing Manager', 'MKTM', 60), d('Marketing Executive', 'MKTE', 20),
  d('Digital Marketing Specialist', 'DMS', 30), d('Content Writer', 'CW', 20), d('Graphic Designer', 'GD', 20), d('Customer Success Manager', 'CSM', 50),
  d('Customer Service Executive', 'CSE', 10), d('Customer Support Representative', 'CSR', 10), d('Telecaller', 'TELE', 5),
  // Operations, administration and legal
  d('Operations Manager', 'OPSM', 60), d('Operations Executive', 'OPSE', 20), d('Administration Manager', 'ADMM', 60), d('Administrative Executive', 'ADME', 20),
  d('Office Manager', 'OFM', 40), d('Executive Assistant', 'EA', 30), d('Receptionist', 'RCP', 5), d('Office Assistant', 'OA', 5), d('Office Boy', 'OB', 0),
  d('Legal Counsel', 'LC', 60), d('Company Secretary', 'CS', 60), d('Compliance Officer', 'CO', 40), d('Procurement Manager', 'PROCM', 60), d('Purchase Executive', 'PURE', 20),
  d('Facility Manager', 'FACM', 50), d('Security Guard', 'SG', 0), d('Housekeeping Staff', 'HKS', 0), d('Driver', 'DRV', 0),
  // Technology
  d('IT Manager', 'ITM', 60), d('System Administrator', 'SYSA', 30), d('Network Engineer', 'NETE', 30), d('IT Support Engineer', 'ITSE', 20), d('Data Analyst', 'DA', 30),
];


const INDUSTRY_DESIGNATIONS: Record<Industry, CatalogueDesignation[]> = {
  it_services: [{ name: 'Software Engineer', code: 'SWE', level: 20 }, { name: 'Senior Software Engineer', code: 'SSE', level: 30 }, { name: 'Technical Architect', code: 'ARCH', level: 60 }, { name: 'QA Engineer', code: 'QAE', level: 20 }, { name: 'Project Manager', code: 'PM', level: 60 }, { name: 'Business Analyst', code: 'BA', level: 30 }, d('Associate Software Engineer', 'ASE', 10), d('Lead Software Engineer', 'LSE', 40), d('Principal Engineer', 'PE', 70), d('Engineering Manager', 'EM', 60), d('DevOps Engineer', 'DOE', 30), d('Data Scientist', 'DS', 40), d('UI/UX Designer', 'UXD', 30), d('Product Manager', 'PDM', 60), d('Scrum Master', 'SCRM', 40), d('Solution Architect', 'SA', 60), d('Technical Support Engineer', 'TSE', 20), d('Test Lead', 'TSTL', 40)],
  manufacturing: [{ name: 'Plant Head', code: 'PH', level: 80 }, { name: 'Production Supervisor', code: 'PSUP', level: 30 }, { name: 'Quality Inspector', code: 'QI', level: 20 }, { name: 'Machine Operator', code: 'OPR', level: 10 }, { name: 'Technician', code: 'TECH', level: 10 }, { name: 'Store Keeper', code: 'SK', level: 10 }, d('Production Manager', 'PRDM', 60), d('Quality Manager', 'QM', 60), d('Maintenance Engineer', 'ME', 30), d('Production Engineer', 'PE', 30), d('Shift Incharge', 'SHI', 30), d('Electrician', 'ELEC', 10), d('Fitter', 'FIT', 10), d('Welder', 'WELD', 10), d('Helper', 'HLP', 0), d('Safety Officer', 'SO', 30)],
  retail: [{ name: 'Store Manager', code: 'STM', level: 60 }, { name: 'Assistant Store Manager', code: 'ASM', level: 50 }, { name: 'Cashier', code: 'CASH', level: 10 }, { name: 'Sales Associate', code: 'SA', level: 10 }, { name: 'Visual Merchandiser', code: 'VM', level: 20 }, d('Area Manager', 'ARM', 60), d('Department Manager', 'DPM', 40), d('Floor Supervisor', 'FS', 30), d('Inventory Controller', 'IC', 20), d('Store Associate', 'STA', 10), d('Billing Executive', 'BILL', 10)],
  healthcare: [{ name: 'Consultant Doctor', code: 'DOC', level: 70 }, { name: 'Resident Doctor', code: 'RMO', level: 50 }, { name: 'Staff Nurse', code: 'SN', level: 20 }, { name: 'Pharmacist', code: 'PHA', level: 20 }, { name: 'Lab Technician', code: 'LT', level: 10 }, d('Medical Superintendent', 'MS', 90), d('Nursing Superintendent', 'NS', 60), d('Head Nurse', 'HN', 40), d('Physiotherapist', 'PT', 30), d('Radiographer', 'RAD', 20), d('Medical Records Officer', 'MRO', 20), d('Ward Attendant', 'WA', 0)],
  staffing: [{ name: 'Recruiter', code: 'REC', level: 20 }, { name: 'Senior Recruiter', code: 'SREC', level: 30 }, { name: 'Account Manager', code: 'ACM', level: 50 }, { name: 'Payroll Executive', code: 'PAYE', level: 20 }, d('Recruitment Manager', 'RECM', 60), d('Talent Sourcer', 'TS', 10), d('Client Relationship Manager', 'CRM', 50), d('Delivery Manager', 'DLM', 60), d('Onboarding Executive', 'ONB', 20)],
  financial_services: [{ name: 'Relationship Manager', code: 'RM', level: 40 }, { name: 'Credit Analyst', code: 'CA', level: 30 }, { name: 'Branch Manager', code: 'BM', level: 60 }, { name: 'Teller', code: 'TELL', level: 10 }, d('Loan Officer', 'LO', 20), d('Investment Analyst', 'IA', 30), d('Risk Manager', 'RSKM', 60), d('Collections Executive', 'COLL', 10), d('Wealth Manager', 'WM', 50), d('Operations Officer', 'OO', 20)],
  education: [{ name: 'Principal', code: 'PRIN', level: 80 }, { name: 'Professor', code: 'PROF', level: 60 }, { name: 'Teacher', code: 'TCH', level: 30 }, { name: 'Lab Assistant', code: 'LA', level: 10 }, d('Vice Principal', 'VPRIN', 70), d('Head of Department', 'HOD', 60), d('Associate Professor', 'APROF', 50), d('Assistant Professor', 'ASPROF', 40), d('Lecturer', 'LECT', 30), d('Librarian', 'LIB', 20), d('Counsellor', 'COUN', 20), d('Admission Counsellor', 'ADMC', 20)],
  logistics: [{ name: 'Warehouse Manager', code: 'WHM', level: 60 }, { name: 'Supervisor', code: 'SUP', level: 30 }, { name: 'Driver', code: 'DRV', level: 10 }, { name: 'Picker / Packer', code: 'PICK', level: 5 }, d('Logistics Manager', 'LOGM', 60), d('Fleet Manager', 'FLTM', 50), d('Dispatch Executive', 'DISP', 20), d('Inventory Executive', 'INVE', 20), d('Forklift Operator', 'FORK', 5), d('Delivery Executive', 'DELE', 5), d('Loader', 'LOAD', 0)],
  hospitality: [{ name: 'Front Office Manager', code: 'FOM', level: 60 }, { name: 'Chef', code: 'CHEF', level: 40 }, { name: 'Steward', code: 'STW', level: 10 }, { name: 'Housekeeping Attendant', code: 'HKA', level: 5 }, d('General Manager Hotel', 'GMH', 90), d('Executive Chef', 'EXCH', 60), d('Sous Chef', 'SOUS', 40), d('Restaurant Manager', 'RSTM', 50), d('Front Desk Executive', 'FDE', 10), d('Concierge', 'CONC', 10), d('Waiter', 'WAIT', 5), d('Bartender', 'BAR', 10)],
  construction: [{ name: 'Project Manager', code: 'PM', level: 60 }, { name: 'Site Engineer', code: 'SITEE', level: 30 }, { name: 'Safety Officer', code: 'SO', level: 30 }, { name: 'Foreman', code: 'FORE', level: 20 }, d('Project Director', 'PD', 90), d('Site Supervisor', 'SSUP', 30), d('Quantity Surveyor', 'QS', 40), d('Civil Engineer', 'CE', 30), d('Architect', 'ARCHT', 50), d('Draughtsman', 'DRAFT', 20), d('Mason', 'MAS', 5), d('Labourer', 'LAB', 0)],
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

/** Suggested designations for an industry, most senior first: its own titles and the core common ones. */
export function suggestedDesignations(industry: Industry | null | undefined): CatalogueDesignation[] {
  const core = COMMON_DESIGNATIONS.filter((x) => CORE_DESIGNATIONS.includes(x.name));
  return uniqueBy([...(INDUSTRY_DESIGNATIONS[industry ?? 'other'] ?? []), ...core]).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}

/**
 * Every title SampCrew knows, for any industry: what the hire form and the designation list suggest as people type.
 * Anyone can still type a title that is not here.
 */
export function designationLibrary(): CatalogueDesignation[] {
  return uniqueBy([...COMMON_DESIGNATIONS, ...Object.values(INDUSTRY_DESIGNATIONS).flat()]).sort((a, b) => a.name.localeCompare(b.name));
}

/** The catalogue entry for a title, matched without regard to case or extra spaces. */
export function catalogueDesignation(title: string): CatalogueDesignation | undefined {
  const key = title.trim().replace(/\s+/g, ' ').toLowerCase();
  return designationLibrary().find((x) => x.name.toLowerCase() === key);
}

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const setupCompanyInput = z.object({
  name,
  legalName: optionalText(200),
  industry: z.enum(INDUSTRIES),
  companySize: z.enum(COMPANY_SIZES),
  website: z.string().trim().max(200).regex(/^https?:\/\/\S+$/, 'Start the website with https://').optional(),
  contactEmail: email.optional(),
  contactPhone: phoneNumber.optional(),
  countryCode,
  currency: currencyCode,
  timezone,
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  registrationNumber: optionalText(64),
  taxId: optionalText(64),
  address: optionalText(500),
  /** How attendance reads the location (GPS), chosen at registration (issue #86). Left out keeps the current choice. */
  locationTracking: z.enum(LOCATION_TRACKING).optional(),
  /** The office network addresses (IPs or IPv4 ranges); a check-in from any other network counts as Work From Home. */
  officeIps: officeIpsInput.optional(),
});
export type SetupCompanyInput = z.infer<typeof setupCompanyInput>;

/** Departments and designations to add in one go. Names that already exist are skipped, not duplicated. */
export const setupStructureInput = z.object({
  departments: z.array(z.object({ name, code: code.optional() })).max(60).default([]),
  designations: z.array(z.object({ name, code: z.string().trim().max(20).optional(), level: z.number().int().min(0).max(100).optional() })).max(200).default([]),
});
export type SetupStructureInput = z.infer<typeof setupStructureInput>;

export const setupProgressInput = z.object({ step: z.number().int().min(0).max(SETUP_STEPS.length - 1) });
