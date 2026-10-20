import { z } from "zod";

export const registerSchema = z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z
        .string()
        .trim()
        .email("Valid email is required")
        .max(255),

    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .max(72, "Password must not exceed 72 characters"),
}).strict();

export const loginSchema = z.object({
    email: z
        .string()
        .trim()
        .email("Valid email is required")
        .max(255),

    password: z
        .string()
        .min(1, "Password is required")
        .max(72, "Password must not exceed 72 characters"),
});

export const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1, "Refresh token is required"),
});

export const logoutSchema = z.object({
    refreshToken: z.string().min(1, "Refresh token is required"),
});

export const sessionIdSchema = z.object({
    id: z.string().uuid("Invalid session ID"),
});

export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "Current password is required").max(72),
    newPassword: z
        .string()
        .min(8, "New password must be at least 8 characters")
        .max(72, "New password must not exceed 72 characters"),
}).strict().refine(
    (input) => input.currentPassword !== input.newPassword,
    "New password must be different from current password",
);

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
