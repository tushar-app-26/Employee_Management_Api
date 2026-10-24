import { AppDataSource } from "../config/database.js";
import { DepartmentEntity } from "../entities/department.entity.js";
import { UserEntity } from "../entities/user.entity.js";
import { EmployeeEntity } from "../entities/employee.entity.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { AppError } from "../errors/app-error.js";
import { auditService } from "./audit.service.js";
import type { AuthPayload } from "../middlewares/auth.middleware.js";
import type { CreateEmployeeInput, UpdateEmployeeInput } from "../domain/employee.js";
import type { EmployeeListQuery } from "../validators/employee.validator.js";

const employeeSortColumns = {
    createdAt: "employee.createdAt",
    workEmail: "employee.workEmail",
    joiningDate: "employee.joiningDate",
    employmentStatus: "employee.employmentStatus",
} as const;

const defaultListQuery: EmployeeListQuery = {
    page: 1,
    limit: 10,
    sortBy: "createdAt",
    sortOrder: "desc",
};

function toEmployeeResponse(employee: EmployeeEntity) {
    return {
        id: employee.id,
        userId: employee.userId,
        firstName: employee.user?.firstName ?? employee.firstName ?? "",
        lastName: employee.user?.lastName ?? employee.lastName ?? "",
        workEmail: employee.workEmail,
        phone: employee.phone,
        departmentId: employee.departmentId,
        managerId: employee.managerId,
        jobTitle: employee.jobTitle,
        joiningDate: employee.joiningDate,
        employmentStatus: employee.employmentStatus,
        createdAt: employee.createdAt,
        updatedAt: employee.updatedAt,
    };
}

function emptyPage(page: number, limit: number) {
    return { items: [], pagination: { page, limit, total: 0, totalPages: 0 } };
}

export class EmployeeService {
    async getAllEmployees(
        options: EmployeeListQuery = defaultListQuery,
        actor?: AuthPayload,
    ) {
        const { page, limit } = options;
        const direction = options.sortOrder === "asc" ? "ASC" : "DESC";
        const query = employeeRepository
            .createQueryBuilder("employee")
            .leftJoinAndSelect("employee.user", "user")
            .skip((page - 1) * limit)
            .take(limit);

        if (actor?.role === "manager") {
            const manager = await employeeRepository.findOneBy({ userId: actor.sub });
            if (!manager) return emptyPage(page, limit);
            query.andWhere("employee.managerId = :managerId", { managerId: manager.id });
            query.andWhere("employee.employmentStatus NOT IN (:...inactiveStatuses)", {
                inactiveStatuses: ["inactive", "terminated"],
            });
        } else if (actor && actor.role !== "admin" && actor.role !== "hr") {
            throw new AppError(403, "Use your own profile endpoint to view your profile");
        }

        if (options.search) {
            query.andWhere(`(
                user.first_name ILIKE :search
                OR user.last_name ILIKE :search
                OR employee.first_name ILIKE :search
                OR employee.last_name ILIKE :search
                OR employee.work_email ILIKE :search
            )`, { search: `%${options.search}%` });
        }
        if (options.departmentId) {
            query.andWhere("employee.departmentId = :departmentId", { departmentId: options.departmentId });
        }
        if (options.employmentStatus) {
            query.andWhere("employee.employmentStatus = :status", { status: options.employmentStatus });
        }

        if (options.sortBy === "firstName" || options.sortBy === "lastName") {
            const field = options.sortBy === "firstName" ? "first_name" : "last_name";
            query.addSelect(`COALESCE(user.${field}, employee.${field})`, `employee_sort_${field}`)
                .orderBy(`employee_sort_${field}`, direction);
        } else {
            query.orderBy(employeeSortColumns[options.sortBy], direction);
        }

        const [employees, total] = await query.getManyAndCount();
        return {
            items: employees.map(toEmployeeResponse),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        };
    }

    async getEmployeeById(id: string, actor?: AuthPayload) {
        const employee = await employeeRepository
            .createQueryBuilder("employee")
            .leftJoinAndSelect("employee.user", "user")
            .where("employee.id = :id", { id })
            .getOne();

        if (!employee) return null;
        if (actor?.role === "manager") {
            const manager = await employeeRepository.findOneBy({ userId: actor.sub });
            if (!manager || employee.managerId !== manager.id || ["inactive", "terminated"].includes(employee.employmentStatus)) return null;
        } else if (actor && actor.role !== "admin" && actor.role !== "hr") {
            return null;
        }
        return toEmployeeResponse(employee);
    }

    async getMyEmployee(userId: string) {
        const employee = await employeeRepository.findOne({
            where: { userId }, relations: { user: true },
        });
        return employee ? toEmployeeResponse(employee) : null;
    }

    async updateMyEmployee(
        userId: string,
        input: { firstName?: string; lastName?: string; phone?: string | null },
        requestId?: string,
    ) {
        return AppDataSource.transaction(async (manager) => {
            const users = manager.getRepository(UserEntity);
            const employees = manager.getRepository(EmployeeEntity);
            const user = await users.findOneBy({ id: userId });
            const employee = await employees.findOne({ where: { userId }, relations: { user: true } });
            if (!user || !employee) throw new AppError(404, "Employee profile not found");

            if (input.firstName !== undefined) user.firstName = input.firstName;
            if (input.lastName !== undefined) user.lastName = input.lastName;
            if (input.firstName !== undefined) employee.firstName = input.firstName;
            if (input.lastName !== undefined) employee.lastName = input.lastName;
            if (input.phone !== undefined) employee.phone = input.phone;
            await users.save(user);
            const saved = await employees.save(employee);
            saved.user = user;
            await auditService.record({
                actorUserId: userId, action: "employee.self_profile_updated",
                resourceType: "employee", resourceId: employee.id, requestId,
                details: { fields: Object.keys(input) },
            }, manager);
            return toEmployeeResponse(saved);
        });
    }

    async exportMyData(userId: string, requestId?: string) {
        const user = await userRepository.findOneBy({ id: userId });
        if (!user) throw new AppError(404, "Account not found");
        const employee = await this.getMyEmployee(userId);
        await auditService.record({
            actorUserId: userId, action: "employee.self_data_exported",
            resourceType: "user", resourceId: userId, requestId,
        });
        return {
            exportedAt: new Date().toISOString(),
            account: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role },
            employee,
        };
    }

    async createEmployee(input: CreateEmployeeInput, actorUserId?: string, requestId?: string) {
        return AppDataSource.transaction(async (manager) => {
            const users = manager.getRepository(UserEntity);
            const employees = manager.getRepository(EmployeeEntity);
            const departments = manager.getRepository(DepartmentEntity);
            const user = await users.findOneBy({ id: input.userId });
            if (!user) throw new AppError(404, "Registered user not found");
            if (user.role !== "employee") throw new AppError(400, "Only employee-role accounts can be linked to an employee profile");
            if (!user.isActive) throw new AppError(400, "Inactive accounts cannot be linked to an employee profile");
            if (await employees.findOneBy({ userId: input.userId })) throw new AppError(409, "This user already has an employee profile");
            if (!await departments.findOneBy({ id: input.departmentId })) throw new AppError(404, "Department not found");
            if (input.managerId && !await employees.findOneBy({ id: input.managerId })) throw new AppError(404, "Manager not found");

            const firstName = input.firstName ?? user.firstName;
            const lastName = input.lastName ?? user.lastName;
            if (!firstName || !lastName) throw new AppError(400, "HR must provide firstName and lastName for this account");
            if (input.firstName !== undefined) user.firstName = input.firstName;
            if (input.lastName !== undefined) user.lastName = input.lastName;
            if (input.firstName !== undefined || input.lastName !== undefined) await users.save(user);

            const employee = employees.create({
                firstName, lastName, userId: user.id, user,
                workEmail: input.workEmail, phone: input.phone ?? null,
                departmentId: input.departmentId, managerId: input.managerId ?? null,
                jobTitle: input.jobTitle, joiningDate: input.joiningDate,
            });
            const saved = await employees.save(employee);
            saved.user = user;
            await auditService.record({
                actorUserId: actorUserId ?? null, action: "employee.profile_created", resourceType: "employee",
                resourceId: saved.id, requestId, details: { linkedUserId: user.id },
            }, manager);
            return toEmployeeResponse(saved);
        });
    }

    async updateEmployee(id: string, input: UpdateEmployeeInput, actor: AuthPayload, requestId?: string) {
        return AppDataSource.transaction(async (manager) => {
            const employees = manager.getRepository(EmployeeEntity);
            const employee = await employees.findOne({ where: { id }, relations: { user: true } });
            if (!employee) return null;

            if (actor.role === "manager") {
                const managerProfile = await employees.findOneBy({ userId: actor.sub });
                if (!managerProfile || employee.managerId !== managerProfile.id || ["inactive", "terminated"].includes(employee.employmentStatus)) return null;
                const allowed = new Set(["phone", "jobTitle"]);
                const forbidden = Object.keys(input).filter((key) => !allowed.has(key));
                if (forbidden.length) throw new AppError(403, "Managers may only update phone and job title for direct reports");
            } else if (actor.role !== "admin" && actor.role !== "hr") {
                throw new AppError(403, "You cannot update this employee profile");
            }

            const disablesAccount = input.employmentStatus === "inactive" || input.employmentStatus === "terminated";
            if (disablesAccount && employee.userId) {
                const linkedUser = await manager.getRepository(UserEntity).findOneBy({ id: employee.userId });
                if (linkedUser?.role === "admin" && linkedUser.isActive) {
                    if (linkedUser.id === actor.sub) {
                        throw new AppError(400, "Administrators cannot deactivate their own account");
                    }
                    const activeAdmins: Array<{ id: string }> = await manager.query(
                        "SELECT id FROM users WHERE role_id = 'admin' AND is_active = TRUE FOR UPDATE",
                    );
                    if (activeAdmins.length <= 1) {
                        throw new AppError(400, "The last active administrator cannot be deactivated or demoted");
                    }
                }
            }

            if (input.departmentId !== undefined && !await manager.getRepository(DepartmentEntity).findOneBy({ id: input.departmentId })) {
                throw new AppError(404, "Department not found");
            }
            if (input.managerId) {
                const targetManager = await employees.findOneBy({ id: input.managerId });
                if (!targetManager) throw new AppError(404, "Manager not found");
                if (targetManager.id === employee.id) throw new AppError(400, "An employee cannot be their own manager");
            }

            const { firstName, lastName, ...employmentFields } = input;
            if (employee.user) {
                if (firstName !== undefined) employee.user.firstName = firstName;
                if (lastName !== undefined) employee.user.lastName = lastName;
                employee.firstName = employee.user.firstName;
                employee.lastName = employee.user.lastName;
                if (firstName !== undefined || lastName !== undefined) await manager.getRepository(UserEntity).save(employee.user);
            } else {
                if (firstName !== undefined) employee.firstName = firstName;
                if (lastName !== undefined) employee.lastName = lastName;
            }
            Object.assign(employee, employmentFields);
            const saved = await employees.save(employee);
            if (saved.user) saved.user = employee.user;

            if ((saved.employmentStatus === "inactive" || saved.employmentStatus === "terminated") && saved.userId) {
                await manager.getRepository(UserEntity).update({ id: saved.userId }, { isActive: false });
                await manager.getRepository(RefreshTokenEntity).createQueryBuilder()
                    .update(RefreshTokenEntity).set({ revokedAt: new Date() })
                    .where('"user_id" = :userId', { userId: saved.userId })
                    .andWhere('"revoked_at" IS NULL').execute();
            }
            await auditService.record({
                actorUserId: actor.sub, action: "employee.profile_updated", resourceType: "employee",
                resourceId: saved.id, requestId, details: { fields: Object.keys(input) },
            }, manager);
            return toEmployeeResponse(saved);
        });
    }

    async deleteEmployee(id: string, actorUserId?: string, requestId?: string) {
        return AppDataSource.transaction(async (manager) => {
            const employees = manager.getRepository(EmployeeEntity);
            const employee = await employees.findOneBy({ id });
            if (!employee) return false;
            employee.employmentStatus = "inactive";
            await employees.save(employee);
            if (employee.userId) {
                await manager.getRepository(UserEntity).update({ id: employee.userId }, { isActive: false });
                await manager.getRepository(RefreshTokenEntity).createQueryBuilder()
                    .update(RefreshTokenEntity).set({ revokedAt: new Date() })
                    .where('"user_id" = :userId', { userId: employee.userId })
                    .andWhere('"revoked_at" IS NULL').execute();
            }
            await auditService.record({
                actorUserId: actorUserId ?? null, action: "employee.deactivated", resourceType: "employee",
                resourceId: employee.id, requestId,
                details: { linkedUserDeactivated: Boolean(employee.userId) },
            }, manager);
            return true;
        });
    }
}

export const employeeService = new EmployeeService();
