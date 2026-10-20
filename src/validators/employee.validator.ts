import { z } from "zod";

const uuidSchema = z.string().uuid("Invalid UUID");

const employmentStatusSchema = z.enum([
    "active",
    "inactive",
    "on_leave",
    "terminated",
]);

export const employeeListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().max(100).optional(),
    departmentId: uuidSchema.optional(),
    employmentStatus: employmentStatusSchema.optional(),
    sortBy: z.enum([
        "createdAt",
        "firstName",
        "lastName",
        "workEmail",
        "joiningDate",
        "employmentStatus",
    ]).default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
}).strict();

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export const createEmployeeSchema = z.object({
    userId: uuidSchema,
    // Optional fallback for accounts registered before name collection was added.
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    workEmail: z.string().trim().email().max(255),
    phone: z.string().trim().min(7).max(20).optional(),
    departmentId: uuidSchema,
    managerId: uuidSchema.nullable().optional(),
    jobTitle: z.string().trim().min(1).max(100),
    joiningDate: z.iso.date(),
}).strict().refine(
    (data) => (data.firstName === undefined) === (data.lastName === undefined),
    "Provide both firstName and lastName together",
);

export const updateEmployeeSchema = z.object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    workEmail: z.string().trim().email().max(255).optional(),
    phone: z.string().trim().min(7).max(20).nullable().optional(),
    departmentId: uuidSchema.optional(),
    managerId: uuidSchema.nullable().optional(),
    jobTitle: z.string().trim().min(1).max(100).optional(),
    joiningDate: z.iso.date().optional(),
    employmentStatus: employmentStatusSchema.optional(),
})
    .strict()
    .refine(
        (data) => Object.keys(data).length > 0,
        "At least one field must be provided",
    );

export const employeeIdSchema = z.object({
    id: uuidSchema,
});

export const updateOwnEmployeeSchema = z.object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(7).max(20).nullable().optional(),
}).strict().refine(
    (data) => Object.keys(data).length > 0,
    "At least one permitted profile field must be provided",
);
