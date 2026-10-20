import "reflect-metadata";
import bcrypt from "bcrypt";
import { config } from "../config/config.js";
import { AppDataSource } from "../config/database.js";
import { userRepository } from "../repositories/user.repository.js";

async function createDevelopmentAdmin(): Promise<void> {
    if (config.NODE_ENV !== "development") {
        console.error("This command is available only when NODE_ENV=development.");
        process.exitCode = 1;
        return;
    }
    const email = process.env.DEV_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.DEV_ADMIN_PASSWORD;
    const firstName = process.env.DEV_ADMIN_FIRST_NAME?.trim();
    const lastName = process.env.DEV_ADMIN_LAST_NAME?.trim();
    if (!email || !email.includes("@") || !firstName || !lastName || !password || password.length < 12 || password.length > 72) {
        console.error("Set DEV_ADMIN_FIRST_NAME, DEV_ADMIN_LAST_NAME, DEV_ADMIN_EMAIL, and a 12-72 character DEV_ADMIN_PASSWORD in the local development environment.");
        process.exitCode = 1;
        return;
    }

    try {
        await AppDataSource.initialize();
        if (await userRepository.findOneBy({ email })) {
            console.error("That account already exists. No account was changed.");
            process.exitCode = 1;
            return;
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const user = userRepository.create({ firstName, lastName, email, passwordHash, role: "admin", isActive: true });
        await userRepository.save(user);
        console.log(`Development admin account created for ${email}.`);
    } catch {
        console.error("Could not create the development admin account. Check the local database connection and schema.");
        process.exitCode = 1;
    } finally {
        if (AppDataSource.isInitialized) await AppDataSource.destroy();
    }
}

void createDevelopmentAdmin();
