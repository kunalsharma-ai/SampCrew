export interface AssetRow {
  id: string;
  assetCode: string;
  name: string;
  category: string | null;
  categoryId: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  status: string;
  condition: string;
  location: string | null;
  warrantyExpiry: string | null;
  warrantyExpired: boolean;
  holder: { employeeId: string; name: string; code: string | null; since: string; acknowledged: boolean; expectedReturnOn: string | null } | null;
}
export interface AssetList { items: AssetRow[]; counts: Record<string, number>; canCreate: boolean; canExport: boolean }
export interface Category { id: string; name: string; code: string; description: string | null; isDefault: boolean; archived: boolean; assetCount: number }

export interface AssetDetail {
  id: string;
  assetCode: string;
  name: string;
  categoryId: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  purchasePrice: string | null;
  currency: string | null;
  vendor: string | null;
  warrantyExpiry: string | null;
  condition: string;
  status: string;
  location: string | null;
  description: string | null;
  remarks: string | null;
  createdAt: string;
  assignments: {
    id: string; employeeId: string; employeeName: string | null; employeeCode: string | null; department: string | null; designation: string | null; status: string;
    assignedOn: string; expectedReturnOn: string | null; conditionAtAssignment: string; assignedBy: string | null; notes: string | null; requiresAcknowledgement: boolean;
    acknowledgement: { at: string; name: string; text: string; sha256: string; ip: string | null; comment: string | null } | null;
    returnedOn: string | null; conditionAtReturn: string | null; returnNotes: string | null; receivedBy: string | null;
  }[];
  history: { id: string; kind: string; from: string | null; to: string | null; note: string | null; vendor: string | null; cost: string | null; by: string | null; at: string }[];
  files: { id: string; title: string; fileName: string; sizeBytes: number; uploadedBy: string | null; createdAt: string }[];
  can: { edit: boolean; assign: boolean; return: boolean; moves: string[]; writeOff: boolean; delete: boolean };
}

export interface MyAsset {
  assignmentId: string; assetId: string; assetCode: string; name: string; category: string | null; brand: string | null; model: string | null; serialNumber: string | null;
  status: string; assignedOn: string; expectedReturnOn: string | null; condition: string; notes: string | null; returnedOn: string | null;
  needsAcknowledgement: boolean; acknowledgedAt: string | null; acceptanceText: string;
}
