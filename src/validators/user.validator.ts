import { z } from "zod";

export const updateUserAccessSchema = z.object({
    role: z.enum(["admin", "hr", "manager", "employee"]).optional(),
    isActive: z.boolean().optional(),
}).strict().refine(
    (input) => Object.keys(input).length > 0,
    "Provide a role or account status to update",
);

export const userIdSchema = z.object({
    id: z.string().uuid("Invalid user ID"),
});
