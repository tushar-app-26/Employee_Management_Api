import { createTransport } from "nodemailer";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";

const transporter = config.SMTP_HOST
    ? createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
    })
    : undefined;
const testVerificationTokens = new Map<string, string>();

export class EmailVerificationService {
    async send(email: string, token: string): Promise<void> {
        if (config.NODE_ENV === "test") testVerificationTokens.set(email, token);
        const verificationUrl = new URL("/api/v1/auth/verify-email", config.PUBLIC_API_URL);
        verificationUrl.searchParams.set("token", token);

        if (!transporter) {
            logger.info({ email, verificationUrl: verificationUrl.toString() }, "Development email verification link");
            return;
        }

        await transporter.sendMail({
            from: config.EMAIL_FROM,
            to: email,
            subject: "Verify your employee account email",
            text: `Verify your email address within 24 hours: ${verificationUrl.toString()}`,
            html: `<p>Verify your email address within 24 hours.</p><p><a href="${verificationUrl.toString()}">Verify email</a></p>`,
        });
    }
}

export function getVerificationTokenForTest(email: string): string | undefined {
    if (config.NODE_ENV !== "test") throw new Error("Verification token access is only available in tests");
    return testVerificationTokens.get(email);
}

export const emailVerificationService = new EmailVerificationService();
