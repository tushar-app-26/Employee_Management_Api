export interface Department {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateDepartmentInput {
    name: string;
    description?: string;
}

export interface UpdateDepartmentInput {
    name?: string;
    description?: string | null;
}