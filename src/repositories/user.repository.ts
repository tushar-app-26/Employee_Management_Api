
import { AppDataSource } from "../config/database.js";
import { UserEntity } from "../entities/user.entity.js";
import { EmployeeEntity } from "../entities/employee.entity.js";

export const userRepository =
    AppDataSource.getRepository(UserEntity);

export async function listUnlinkedEmployeeUsers(page: number, limit: number) {
    const query = userRepository
        .createQueryBuilder("user")
        .leftJoin(EmployeeEntity, "employeeProfile", "employeeProfile.user_id = user.id")
        .where("user.role = :role", { role: "employee" })
        .andWhere("user.isActive = TRUE")
        .andWhere("employeeProfile.id IS NULL")
        .select(["user.id", "user.firstName", "user.lastName", "user.email", "user.role", "user.createdAt"])
        .orderBy("user.createdAt", "ASC");
    const [users, total] = await query.skip((page - 1) * limit).take(limit).getManyAndCount();
    return {
        items: users.map((user) => ({
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
}
