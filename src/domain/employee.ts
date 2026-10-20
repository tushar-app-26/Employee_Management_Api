export type EmploymentStatus =
    | "active"
    | "inactive"
    | "on_leave"
    | "terminated";

export interface Employee {
    id: string;
    userId: string | null;
    firstName: string;
    lastName: string;
    workEmail: string;
    phone: string | null;
    departmentId: string;
    managerId: string | null;
    jobTitle: string;
    joiningDate: string;
    employmentStatus: EmploymentStatus;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateEmployeeInput {
    userId: string;
    firstName?: string;
    lastName?: string;
    workEmail: string;
    phone?: string;
    departmentId: string;
    managerId?: string | null;
    jobTitle: string;
    joiningDate: string;
}

export interface UpdateEmployeeInput {
    firstName?: string;
    lastName?: string;
    workEmail?: string;
    phone?: string | null;
    departmentId?: string;
    managerId?: string | null;
    jobTitle?: string;
    joiningDate?: string;
    employmentStatus?: EmploymentStatus;
}
