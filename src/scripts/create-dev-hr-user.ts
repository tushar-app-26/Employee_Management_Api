import "reflect-metadata";
import bcrypt from "bcrypt";

import { config } from "../config/config.js";
import { AppDataSource } from "../config/database.js";
import { userRepository } from "../repositories/user.repository.js";

async function createDevelopmentHrUser(): Promise<void> {
    if (config.NODE_ENV !== "development") {
        console.error("This command is available only when NODE_ENV=development.");
        process.exitCode = 1;
        return;
    }

    const email = process.env.DEV_HR_EMAIL?.trim().toLowerCase();
    const password = process.env.DEV_HR_PASSWORD;
    const firstName = process.env.DEV_HR_FIRST_NAME?.trim();
    const lastName = process.env.DEV_HR_LAST_NAME?.trim();

    if (!firstName || !lastName) {
        console.error("Set DEV_HR_FIRST_NAME and DEV_HR_LAST_NAME for the development HR account.");
        process.exitCode = 1;
        return;
    }

    if (!email || !email.includes("@")) {
        console.error("Set DEV_HR_EMAIL to a valid development-only email.");
        process.exitCode = 1;
        return;
    }

    if (!password || password.length < 8 || password.length > 72) {
        console.error("Set DEV_HR_PASSWORD to a password between 8 and 72 characters.");
        process.exitCode = 1;
        return;
    }

    try {
        await AppDataSource.initialize();

        const existingUser = await userRepository.findOneBy({ email });
        if (existingUser) {
            console.error("That email already exists. Choose a new development-only email; no account was changed.");
            process.exitCode = 1;
            return;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const user = userRepository.create({
            firstName,
            lastName,
            email,
            passwordHash,
            role: "hr",
        });

        await userRepository.save(user);
        console.log(`Development HR account created for ${email}. You can now log in through /api/v1/auth/login.`);
    } catch {
        console.error("Could not create the development HR account. Check the local database connection and schema.");
        process.exitCode = 1;
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

void createDevelopmentHrUser();
