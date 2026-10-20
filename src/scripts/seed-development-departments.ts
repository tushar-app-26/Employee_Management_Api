import "reflect-metadata";
import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";
import { DepartmentEntity } from "../entities/department.entity.js";

async function seedDevelopmentDepartments(): Promise<void> {
    if (config.NODE_ENV !== "development") {
        console.error("Development reference data can only be seeded when NODE_ENV=development.");
        process.exitCode = 1;
        return;
    }

    try {
        await AppDataSource.initialize();
        const repository = AppDataSource.getRepository(DepartmentEntity);
        for (const [name, description] of [
            ["Engineering", "Development reference department"],
            ["People Operations", "Development reference department"],
            ["Finance", "Development reference department"],
        ]) {
            if (!await repository.findOneBy({ name })) {
                await repository.save(repository.create({ name, description }));
            }
        }
        console.log("Development departments are ready.");
    } catch {
        console.error("Could not seed development departments. Check the database and migrations.");
        process.exitCode = 1;
    } finally {
        if (AppDataSource.isInitialized) await AppDataSource.destroy();
    }
}

void seedDevelopmentDepartments();
