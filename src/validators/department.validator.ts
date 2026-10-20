import { z } from "zod";

export const departmentListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().max(100).optional(),
    sortBy: z.enum(["name", "createdAt", "updatedAt"]).default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
}).strict();

export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;

export const createDepartmentSchema = z.object({
    name: z.string().trim().min(1, "Department name is required").max(100),
    description: z.string().trim().nullable().optional(),
}).strict();

export const updateDepartmentSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().nullable().optional(),
})
    .strict()
    .refine(
        (data) => Object.keys(data).length > 0,
        "At least one field must be provided",
    );

export const departmentIdSchema = z.object({
    id: z.string().uuid("Invalid department ID"),
});
