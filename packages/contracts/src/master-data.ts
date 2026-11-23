import { z } from 'zod';
import { EMPLOYMENT_TYPES, EMPLOYEE_STATUSES } from './schemas/people';
import { designationLibrary } from './setup';

/**
 * Master data: the ready-made choices behind SampCrew's dropdowns, so people pick instead of type. Every list starts
 * from a curated library and stays open: a workspace adds its own values ("Other / add new"), renames, categorises and
 * disables values. Nothing in use is deleted: a disabled value disappears from new choices and records that hold it
 * keep showing it.
 *
 * Where SampCrew already has a real model for a list, master data is that model, never a copy:
 *  - departments are the Organization departments, job titles are the designations, skills are the skills catalogue
 *    (Workforce Universe), locations are the Organization locations;
 *  - employment types and employee statuses are built in (payroll, leave and lifecycle rules depend on them);
 *  - every other list (industries, job roles, education, candidate sources, seniority levels) is kept in the
 *    master_values collection, and custom fields can take their options from it.
 */

export const MASTER_LISTS = ['industry', 'department', 'job_title', 'job_role', 'skill', 'education', 'candidate_source', 'seniority_level', 'location', 'employment_type', 'employment_status'] as const;
export type MasterList = (typeof MASTER_LISTS)[number];

/** Lists kept in master_values (added to, renamed, categorised and disabled freely). */
export const VALUE_LISTS = ['industry', 'job_role', 'education', 'candidate_source', 'seniority_level'] as const;
export type ValueList = (typeof VALUE_LISTS)[number];
export const isValueList = (l: string): l is ValueList => (VALUE_LISTS as readonly string[]).includes(l);

export interface MasterListInfo {
  key: MasterList;
  label: string;
  singular: string;
  description: string;
  /** values: master_values; department/job_title: the Organization records; location: Organization page; system: built in. */
  storage: 'values' | 'departments' | 'designations' | 'skills' | 'locations' | 'system';
  /** Where the values are picked in SampCrew. */
  usedIn: string;
}

export const MASTER_LIST_INFO: Record<MasterList, MasterListInfo> = {
  industry: { key: 'industry', label: 'Industries', singular: 'Industry', storage: 'values', description: 'Industries of clients and companies.', usedIn: 'Clients (staffing bids), custom fields and imports' },
  department: { key: 'department', label: 'Departments', singular: 'Department', storage: 'departments', description: 'The departments people work in (Organization > Departments).', usedIn: 'Add employee, employee records, departments import, reports' },
  job_title: { key: 'job_title', label: 'Job titles', singular: 'Job title', storage: 'designations', description: 'Designations people hold, with their seniority level.', usedIn: 'Add employee, promotions and transfers, employee import' },
  job_role: { key: 'job_role', label: 'Job roles', singular: 'Job role', storage: 'values', description: 'The kind of work someone does (a role family), separate from their title.', usedIn: 'Custom fields, candidate and employee imports' },
  skill: { key: 'skill', label: 'Skills', singular: 'Skill', storage: 'skills', description: 'The skills catalogue shared by profiles, requisitions, staffing bids and Workforce Universe.', usedIn: 'Employee skills, requisitions, custom fields, imports' },
  education: { key: 'education', label: 'Education', singular: 'Qualification', storage: 'values', description: 'Degrees and qualifications.', usedIn: 'Highest qualification on the employee profile, custom fields, imports' },
  candidate_source: { key: 'candidate_source', label: 'Candidate sources', singular: 'Candidate source', storage: 'values', description: 'Where candidates come from, grouped by the kind of source.', usedIn: 'Add candidate, candidate import' },
  seniority_level: { key: 'seniority_level', label: 'Seniority levels', singular: 'Seniority level', storage: 'values', description: 'Career levels from intern to the leadership team.', usedIn: 'Custom fields, imports' },
  location: { key: 'location', label: 'Locations', singular: 'Location', storage: 'locations', description: 'Offices, branches, plants and sites (Organization > Locations).', usedIn: 'Add employee, attendance geofences, imports' },
  employment_type: { key: 'employment_type', label: 'Employment types', singular: 'Employment type', storage: 'system', description: 'Built in: payroll, leave accrual and probation rules depend on them.', usedIn: 'Add employee, imports' },
  employment_status: { key: 'employment_status', label: 'Employment status', singular: 'Employment status', storage: 'system', description: 'Built in: set by the employee lifecycle (joining, confirmation, notice, exit).', usedIn: 'Employee records and reports' },
};

export const EMPLOYMENT_TYPE_LABEL: Record<(typeof EMPLOYMENT_TYPES)[number], string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern', temporary: 'Temporary' };
export const EMPLOYEE_STATUS_LABEL: Record<(typeof EMPLOYEE_STATUSES)[number], string> = { pre_boarding: 'Pre-boarding', probation: 'On probation', active: 'Active', notice: 'Serving notice', exited: 'Exited' };

/** The value people pick to type their own entry. Never stored. */
export const OTHER_OPTION = '__other__';
export const OTHER_OPTION_LABEL = 'Other / add new';

export interface LibraryValue { label: string; category: string; code?: string; level?: number }

const group = (category: string, labels: string[]): LibraryValue[] => labels.map((label) => ({ label, category }));

export const INDUSTRY_LIBRARY: LibraryValue[] = [
  ...group('Technology', ['Information Technology', 'Software', 'SaaS', 'IT Services and Consulting', 'FinTech', 'EdTech', 'HealthTech', 'Cybersecurity', 'Data and Analytics', 'Artificial Intelligence', 'Telecommunications', 'Internet', 'Electronics', 'Semiconductor']),
  ...group('Financial services', ['Banking', 'Financial Services', 'Insurance', 'Investment Management', 'Accounting', 'Capital Markets', 'Microfinance']),
  ...group('Healthcare and life sciences', ['Healthcare', 'Hospitals and Clinics', 'Pharmaceuticals', 'Biotechnology', 'Medical Devices', 'Diagnostics', 'Wellness']),
  ...group('Industrial', ['Manufacturing', 'Electronics Manufacturing', 'Automotive', 'Aerospace and Defense', 'Chemicals', 'Industrial Machinery', 'Textiles', 'Steel and Metals', 'Mining', 'Packaging']),
  ...group('Energy and utilities', ['Energy', 'Renewable Energy', 'Oil and Gas', 'Utilities', 'Power Generation']),
  ...group('Construction and property', ['Construction', 'Real Estate', 'Architecture', 'Facilities Management', 'Infrastructure']),
  ...group('Consumer', ['Retail', 'E-commerce', 'FMCG', 'Consumer Goods', 'Food and Beverage', 'Fashion', 'Beauty and Wellness', 'Luxury Goods', 'Consumer Electronics']),
  ...group('Transport and logistics', ['Logistics', 'Transportation', 'Aviation', 'Shipping and Maritime', 'Warehousing', 'Courier and Delivery']),
  ...group('Hospitality and leisure', ['Hospitality', 'Travel and Tourism', 'Restaurants', 'Sports', 'Fitness', 'Events', 'Gaming']),
  ...group('Media and marketing', ['Media', 'Entertainment', 'Advertising', 'Marketing', 'Public Relations', 'Publishing', 'Broadcasting']),
  ...group('Professional services', ['Consulting', 'Legal Services', 'Professional Services', 'Staffing and Recruitment', 'Business Process Outsourcing', 'Research', 'Security Services']),
  ...group('Trade', ['Import and Export', 'Wholesale', 'Distribution', 'Trading']),
  ...group('Public and social', ['Government', 'Non-Profit', 'Education', 'Higher Education', 'Agriculture', 'Environmental Services']),
  { label: 'Other', category: 'Other' },
];

export const DEPARTMENT_LIBRARY: LibraryValue[] = [
  ...[['Human Resources', 'HR'], ['Recruitment', 'REC'], ['Talent Acquisition', 'TA'], ['Training and Development', 'TND'], ['Learning and Development', 'LND'], ['Payroll', 'PAY'], ['Compensation and Benefits', 'CNB']].map(([label, code]) => ({ label: label!, code, category: 'People' })),
  ...[['Finance', 'FIN'], ['Accounting', 'ACC'], ['Internal Audit', 'AUD'], ['Risk Management', 'RISK'], ['Compliance', 'COMP'], ['Legal', 'LEGAL'], ['Corporate Strategy', 'STRAT']].map(([label, code]) => ({ label: label!, code, category: 'Finance, legal and strategy' })),
  ...[['Sales', 'SALES'], ['Business Development', 'BD'], ['Marketing', 'MKT'], ['Digital Marketing', 'DMKT'], ['Public Relations', 'PR'], ['Communications', 'COMMS'], ['Customer Success', 'CSM'], ['Customer Support', 'SUP']].map(([label, code]) => ({ label: label!, code, category: 'Commercial' })),
  ...[['Product', 'PRODUCT'], ['Product Management', 'PM'], ['Engineering', 'ENG'], ['Software Development', 'DEV'], ['IT', 'IT'], ['Information Security', 'SEC'], ['Quality Assurance', 'QA'], ['Research and Development', 'RND'], ['Data Science', 'DS'], ['Data Analytics', 'DA'], ['Design', 'DESIGN'], ['UI/UX', 'UX']].map(([label, code]) => ({ label: label!, code, category: 'Product and technology' })),
  ...[['Operations', 'OPS'], ['Business Operations', 'BIZOPS'], ['Administration', 'ADMIN'], ['Office Management', 'OFFICE'], ['Facilities', 'FAC'], ['Security', 'SECURITY'], ['Procurement', 'PROC'], ['Supply Chain', 'SCM'], ['Logistics', 'LOG'], ['Project Management', 'PMO'], ['Program Management', 'PGM']].map(([label, code]) => ({ label: label!, code, category: 'Operations' })),
  ...[['Manufacturing', 'MFG'], ['Production', 'PRD'], ['Maintenance', 'MNT'], ['Quality Control', 'QC'], ['Health and Safety', 'EHS']].map(([label, code]) => ({ label: label!, code, category: 'Plant and production' })),
  ...[['Management', 'MGMT'], ['Executive', 'EXEC']].map(([label, code]) => ({ label: label!, code, category: 'Leadership' })),
  { label: 'Other', code: 'OTHER', category: 'Other' },
];

const titles = (category: string, rows: [string, number][]): LibraryValue[] => rows.map(([label, level]) => ({ label, category, level }));

/** Job titles from the specification, by function, merged with the titles setup already offers. */
export const JOB_TITLE_LIBRARY: LibraryValue[] = (() => {
  const curated: LibraryValue[] = [
    ...titles('Executive and leadership', [['Founder', 100], ['Co-Founder', 100], ['CEO', 100], ['COO', 95], ['CFO', 95], ['CTO', 95], ['CMO', 95], ['CHRO', 95], ['President', 95], ['Vice President', 90], ['Director', 90], ['General Manager', 80], ['Senior Manager', 70], ['Manager', 60], ['Assistant Manager', 50], ['Team Lead', 40]]),
    ...titles('Human resources', [['HR Executive', 20], ['HR Manager', 60], ['HR Business Partner', 50], ['HR Generalist', 30], ['HR Specialist', 30], ['Recruiter', 20], ['Talent Acquisition Specialist', 30], ['Talent Acquisition Manager', 60], ['Recruitment Executive', 20], ['Recruitment Manager', 60], ['Payroll Specialist', 30], ['Compensation and Benefits Specialist', 30], ['Learning and Development Manager', 60]]),
    ...titles('Sales', [['Sales Executive', 20], ['Sales Representative', 10], ['Sales Manager', 60], ['Business Development Executive', 20], ['Business Development Manager', 50], ['Account Executive', 20], ['Account Manager', 50], ['Key Account Manager', 50], ['Sales Director', 90], ['Inside Sales Representative', 10], ['Regional Sales Manager', 60]]),
    ...titles('Marketing', [['Marketing Executive', 20], ['Marketing Manager', 60], ['Digital Marketing Specialist', 30], ['SEO Specialist', 30], ['Content Writer', 20], ['Content Strategist', 40], ['Social Media Manager', 40], ['Brand Manager', 50], ['Performance Marketing Specialist', 30], ['Product Marketing Manager', 60], ['Marketing Director', 90]]),
    ...titles('Technology', [['Software Engineer', 20], ['Software Developer', 20], ['Senior Software Engineer', 30], ['Frontend Developer', 20], ['Backend Developer', 20], ['Full Stack Developer', 30], ['Mobile Developer', 20], ['DevOps Engineer', 30], ['Site Reliability Engineer', 30], ['Cloud Engineer', 30], ['Data Engineer', 30], ['Data Analyst', 30], ['Data Scientist', 40], ['Machine Learning Engineer', 40], ['AI Engineer', 40], ['QA Engineer', 20], ['Automation Engineer', 30], ['Cybersecurity Analyst', 30], ['Security Engineer', 30], ['System Administrator', 30], ['Network Engineer', 30], ['IT Support Specialist', 20], ['Solutions Architect', 60], ['Technical Architect', 60], ['Engineering Manager', 60], ['Product Manager', 60], ['Product Owner', 50], ['Product Designer', 40], ['UX Designer', 30], ['UI Designer', 30], ['Scrum Master', 40]]),
    ...titles('Finance', [['Accountant', 20], ['Senior Accountant', 30], ['Finance Executive', 20], ['Finance Manager', 60], ['Financial Analyst', 30], ['Controller', 70], ['Auditor', 40], ['Tax Specialist', 30], ['Payroll Executive', 20], ['Accounts Payable Executive', 20], ['Accounts Receivable Executive', 20], ['Treasury Manager', 60]]),
    ...titles('Operations', [['Operations Executive', 20], ['Operations Manager', 60], ['Operations Analyst', 30], ['Project Manager', 60], ['Program Manager', 70], ['Supply Chain Manager', 60], ['Procurement Specialist', 30], ['Logistics Manager', 60], ['Quality Analyst', 30], ['Quality Manager', 60], ['Business Analyst', 30], ['Office Administrator', 20]]),
    ...titles('Customer service', [['Customer Support Executive', 10], ['Customer Success Manager', 50], ['Customer Service Representative', 10], ['Call Centre Agent', 5], ['Service Delivery Manager', 60]]),
    ...titles('Legal and compliance', [['Legal Counsel', 60], ['Legal Associate', 30], ['Compliance Officer', 40], ['Company Secretary', 60], ['Paralegal', 20]]),
    ...titles('Early career', [['Intern', 0], ['Trainee', 5], ['Graduate Trainee', 5], ['Apprentice', 0]]),
  ];
  const seen = new Set(curated.map((t) => t.label.toLowerCase()));
  // The titles the setup wizard and the hire form already suggest, so the two lists never disagree.
  const fromSetup = designationLibrary().filter((d) => !seen.has(d.name.toLowerCase())).map((d) => ({ label: d.name, category: 'More titles', level: d.level, code: d.code }));
  return [...curated, ...fromSetup];
})();

export const JOB_ROLE_LIBRARY: LibraryValue[] = [
  ...group('Engineering', ['Software Development', 'Frontend Development', 'Backend Development', 'Full Stack Development', 'Mobile Development', 'DevOps and Cloud', 'Quality Engineering', 'Data Engineering', 'Machine Learning', 'Security Engineering', 'Embedded Systems', 'IT Infrastructure', 'IT Support']),
  ...group('Product and design', ['Product Management', 'Product Design', 'UX Research', 'Visual Design', 'Technical Writing']),
  ...group('Data', ['Data Analysis', 'Data Science', 'Business Intelligence']),
  ...group('Sales and marketing', ['Field Sales', 'Inside Sales', 'Account Management', 'Business Development', 'Pre-sales', 'Digital Marketing', 'Content Marketing', 'Brand Management', 'Performance Marketing', 'Public Relations']),
  ...group('People', ['Recruitment', 'HR Operations', 'HR Business Partnering', 'Payroll', 'Compensation and Benefits', 'Learning and Development', 'Employee Relations']),
  ...group('Finance and legal', ['Accounting', 'Financial Planning and Analysis', 'Taxation', 'Audit', 'Treasury', 'Legal', 'Compliance']),
  ...group('Operations', ['Operations Management', 'Project Management', 'Program Management', 'Procurement', 'Supply Chain', 'Logistics', 'Facilities', 'Administration', 'Quality Management']),
  ...group('Customer', ['Customer Support', 'Customer Success', 'Service Delivery']),
  ...group('Production', ['Production', 'Maintenance', 'Plant Operations', 'Health and Safety']),
  ...group('Leadership', ['General Management', 'Executive Leadership']),
];

export const SKILL_LIBRARY: LibraryValue[] = [
  ...group('Programming', ['JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'C++', 'Go', 'Rust', 'PHP', 'Ruby', 'Kotlin', 'Swift', 'SQL', 'R programming', 'Scala', 'Dart']),
  ...group('Frameworks and tools', ['React', 'Angular', 'Vue.js', 'Next.js', 'Node.js', 'Django', 'Flask', 'Spring Boot', '.NET', 'Flutter', 'React Native', 'GraphQL', 'REST APIs', 'Git']),
  ...group('Cloud and infrastructure', ['AWS', 'Microsoft Azure', 'Google Cloud', 'Docker', 'Kubernetes', 'Terraform', 'Linux', 'CI/CD', 'Networking', 'Cybersecurity']),
  ...group('Data and AI', ['Data Analysis', 'Machine Learning', 'Deep Learning', 'Natural Language Processing', 'Power BI', 'Tableau', 'Excel', 'Statistics', 'Data Visualization', 'MongoDB', 'PostgreSQL', 'MySQL']),
  ...group('Design', ['UI Design', 'UX Research', 'Figma', 'Adobe Photoshop', 'Adobe Illustrator', 'Graphic Design', 'Video Editing']),
  ...group('Business', ['Project Management', 'Agile', 'Scrum', 'Business Analysis', 'Stakeholder Management', 'Budgeting', 'Financial Modelling', 'Strategic Planning', 'Process Improvement', 'Six Sigma']),
  ...group('Sales and marketing', ['Lead Generation', 'Negotiation', 'Account Management', 'CRM', 'Salesforce', 'SEO', 'SEM', 'Social Media Marketing', 'Content Writing', 'Copywriting', 'Email Marketing', 'Market Research']),
  ...group('People and finance', ['Recruitment', 'Talent Sourcing', 'Interviewing', 'Employee Relations', 'Payroll Processing', 'Labour Law', 'Accounting', 'Tally', 'SAP', 'GST', 'Taxation', 'Auditing']),
  ...group('Operations', ['Supply Chain Management', 'Inventory Management', 'Procurement', 'Logistics Planning', 'Quality Control', 'Lean Manufacturing', 'Health and Safety', 'Customer Service']),
  ...group('Personal', ['Communication', 'Leadership', 'Teamwork', 'Problem Solving', 'Time Management', 'Presentation', 'Critical Thinking', 'Adaptability']),
  ...group('Languages', ['English', 'Hindi', 'Arabic', 'French', 'German', 'Spanish', 'Mandarin', 'Japanese']),
];

export const EDUCATION_LIBRARY: LibraryValue[] = [
  ...group('School', ['10th standard', '12th standard', 'High school diploma']),
  ...group('Diploma and certificate', ['Diploma', 'ITI certificate', 'Polytechnic diploma', 'Professional certification']),
  ...group('Bachelor’s degree', ['B.Tech / B.E.', 'B.Sc', 'B.Com', 'B.A.', 'BBA', 'BCA', 'B.Arch', 'B.Pharm', 'MBBS', 'LLB', 'B.Ed', 'Bachelor of Design']),
  ...group('Master’s degree', ['M.Tech / M.E.', 'M.Sc', 'M.Com', 'M.A.', 'MBA', 'PGDM', 'MCA', 'LLM', 'M.Pharm', 'M.Ed', 'MD / MS']),
  ...group('Professional qualification', ['Chartered Accountant (CA)', 'Company Secretary (CS)', 'Cost Accountant (CMA)', 'CFA', 'ACCA', 'CPA', 'PMP']),
  ...group('Doctorate', ['Ph.D', 'Doctorate (other)']),
];

/** Grouped by the kind of source SampCrew records on every candidate (career site, referral, agency, sourced, manual). */
export const CANDIDATE_SOURCE_LIBRARY: LibraryValue[] = [
  ...group('Sourced', ['LinkedIn', 'Naukri', 'Indeed', 'Monster', 'Glassdoor', 'Foundit', 'Shine', 'AngelList / Wellfound', 'GitHub', 'Instagram', 'Facebook']),
  ...group('Career site', ['Company career page', 'Walk-in', 'Campus drive', 'Job fair']),
  ...group('Referral', ['Employee referral', 'Alumni referral', 'Client referral']),
  ...group('Agency', ['Recruitment agency', 'Staffing partner', 'Executive search firm']),
  ...group('Manual', ['Direct application by email', 'Internal transfer', 'Rehire', 'Other']),
];
/** The candidate source kind each library category stands for. */
export const CANDIDATE_SOURCE_KIND: Record<string, 'career_site' | 'referral' | 'agency' | 'sourced' | 'manual'> = {
  Sourced: 'sourced', 'Career site': 'career_site', Referral: 'referral', Agency: 'agency', Manual: 'manual',
};

export const SENIORITY_LIBRARY: LibraryValue[] = [
  { label: 'Intern', category: 'Early career', level: 0 }, { label: 'Trainee', category: 'Early career', level: 5 }, { label: 'Entry level', category: 'Early career', level: 10 },
  { label: 'Associate', category: 'Individual contributor', level: 20 }, { label: 'Mid level', category: 'Individual contributor', level: 30 }, { label: 'Senior', category: 'Individual contributor', level: 40 },
  { label: 'Lead', category: 'Individual contributor', level: 45 }, { label: 'Principal', category: 'Individual contributor', level: 55 },
  { label: 'Manager', category: 'Management', level: 60 }, { label: 'Senior manager', category: 'Management', level: 70 }, { label: 'Director', category: 'Management', level: 85 },
  { label: 'Vice president', category: 'Leadership', level: 90 }, { label: 'C-level executive', category: 'Leadership', level: 100 },
];

export const MASTER_LIBRARY: Record<ValueList, LibraryValue[]> = {
  industry: INDUSTRY_LIBRARY, job_role: JOB_ROLE_LIBRARY, education: EDUCATION_LIBRARY, candidate_source: CANDIDATE_SOURCE_LIBRARY, seniority_level: SENIORITY_LIBRARY,
};

/** The library behind every list that has one (built-in lists and locations have none). */
export function libraryOf(list: MasterList): LibraryValue[] {
  if (isValueList(list)) return MASTER_LIBRARY[list];
  return list === 'department' ? DEPARTMENT_LIBRARY : list === 'job_title' ? JOB_TITLE_LIBRARY : list === 'skill' ? SKILL_LIBRARY : [];
}

/** Lists a custom field (dropdown, radio, multi-select) can take its options from. */
export const FIELD_OPTION_LISTS = ['industry', 'job_role', 'skill', 'education', 'candidate_source', 'seniority_level', 'department', 'job_title'] as const;

/** A stable key from a label: what records store, so a renamed value keeps its records. */
export function masterKey(label: string): string {
  const k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return k || 'value';
}

/** Matching that ignores case, spaces, punctuation and "and"/"&": "R&D" finds "Research and Development" only by its code. */
export function masterNorm(v: string): string {
  return v.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9+#]+/g, '');
}

export interface MasterValue {
  id: string;
  list: MasterList;
  key: string;
  label: string;
  category: string | null;
  code: string | null;
  /** Seniority (job titles and seniority levels), 0 to 100. */
  level: number | null;
  origin: 'library' | 'custom' | 'system';
  disabled: boolean;
  /** Records that use it (employees for departments and job titles). */
  usage: number | null;
}

export interface MasterListSummary extends MasterListInfo { active: number; disabled: number; editable: boolean }

const label = z.string().trim().min(1, 'Enter a name').max(120);
const category = z.string().trim().max(60).nullable().optional();
export const masterValueInput = z.object({
  label,
  category,
  code: z.string().trim().max(20).regex(/^[A-Za-z0-9._-]*$/, 'Letters, numbers, dot, dash and underscore').nullable().optional(),
  level: z.number().int().min(0).max(100).nullable().optional(),
}).strict();
export type MasterValueInput = z.infer<typeof masterValueInput>;
export const masterValueUpdate = masterValueInput.partial().extend({ disabled: z.boolean().optional() }).strict();
export const masterListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(60).optional(),
  disabled: z.enum(['true', 'false', 'all']).default('false'),
});
/** Several library values at once ("Add from the library"). */
export const masterLibraryAddInput = z.object({ labels: z.array(z.string().trim().min(1).max(120)).min(1).max(500) }).strict();

/** Options of a built-in list, for the Master data page. */
export function systemValues(list: 'employment_type' | 'employment_status'): { key: string; label: string }[] {
  return list === 'employment_type' ? EMPLOYMENT_TYPES.map((k) => ({ key: k, label: EMPLOYMENT_TYPE_LABEL[k] })) : EMPLOYEE_STATUSES.map((k) => ({ key: k, label: EMPLOYEE_STATUS_LABEL[k] }));
}
