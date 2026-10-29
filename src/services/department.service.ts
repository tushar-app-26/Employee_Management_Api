import { departmentRepository } from "../repositories/department.repository.js";
import type {
    CreateDepartmentInput,
    UpdateDepartmentInput,
} from "../domain/department.js";
import type { DepartmentListQuery } from "../validators/department.validator.js";
import { auditService } from "./audit.service.js";
import { AppDataSource } from "../config/database.js";
import { DepartmentEntity } from "../entities/department.entity.js";
import { departmentCache } from "./department-cache.service.js";

const departmentSortColumns = {
    name: "department.name",
    createdAt: "department.createdAt",
    updatedAt: "department.updatedAt",
} as const;

const defaultListQuery: DepartmentListQuery = {
    page: 1,
    limit: 10,
    sortBy: "createdAt",
    sortOrder: "desc",
};

export class DepartmentService {
    private async invalidateListCacheAfterCommit(): Promise<void> {
        try {
            await departmentCache.invalidate();
        } catch (error) {
            console.warn("Department cache invalidation failed after commit", error);
        }
    }

    async getAllDepartments(
        options: DepartmentListQuery = defaultListQuery,
    ) {
        const page = options.page;
        const limit = options.limit;
        const useDefaultCache = page === 1
            && limit === 10
            && options.sortBy === "createdAt"
            && options.sortOrder === "desc"
            && options.search === undefined;

        if (useDefaultCache) {
            const cached = await departmentCache.getDefault();
            if (cached) {
                console.info("Department list served from Redis", {
                    cacheKey: "departments:all",
                });
                return cached;
            }
        }

        const direction = options.sortOrder === "asc" ? "ASC" : "DESC";
        const query = departmentRepository
            .createQueryBuilder("department")
            .skip((page - 1) * limit)
            .take(limit);

        if (options.search) {
            query.andWhere(
                "(department.name ILIKE :search OR department.description ILIKE :search)",
                { search: `%${options.search}%` },
            );
        }

        // sortBy is validated and mapped through this fixed allowlist.
        query.orderBy(departmentSortColumns[options.sortBy], direction);

        const [departments, total] = await query.getManyAndCount();
        console.info("Department list served from PostgreSQL", {
            cache: useDefaultCache ? "miss" : "bypassed",
        });
        const result = {
            items: departments,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };

        if (useDefaultCache) await departmentCache.setDefault(result);
        return result;
    }

    async getDepartmentById(id: string) {
        return departmentRepository.findOneBy({ id });
    }

    async createDepartment(input: CreateDepartmentInput, actorUserId?: string, requestId?: string) {
        const department = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(DepartmentEntity);
            const department = repository.create({ name: input.name, description: input.description ?? null });
            const saved = await repository.save(department);
            await auditService.record({ actorUserId: actorUserId ?? null, action: "department.created", resourceType: "department", resourceId: saved.id, requestId, details: { fields: Object.keys(input) } }, manager);
            return saved;
        });
        await this.invalidateListCacheAfterCommit();
        return department;
    }

    async updateDepartment(
        id: string,
        input: UpdateDepartmentInput,
        actorUserId?: string,
        requestId?: string,
    ) {
        const department = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(DepartmentEntity);
            const department = await repository.findOneBy({ id });
            if (!department) return null;
            if (input.name !== undefined) department.name = input.name;
            if (input.description !== undefined) department.description = input.description;
            const saved = await repository.save(department);
            await auditService.record({ actorUserId: actorUserId ?? null, action: "department.updated", resourceType: "department", resourceId: saved.id, requestId, details: { fields: Object.keys(input) } }, manager);
            return saved;
        });
        if (department) await this.invalidateListCacheAfterCommit();
        return department;
    }

    async deleteDepartment(id: string, actorUserId?: string, requestId?: string) {
        const deleted = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(DepartmentEntity);
            const department = await repository.findOneBy({ id });
            if (!department) return false;
            await repository.remove(department);
            await auditService.record({ actorUserId: actorUserId ?? null, action: "department.deleted", resourceType: "department", resourceId: id, requestId }, manager);
            return true;
        });
        if (deleted) await this.invalidateListCacheAfterCommit();
        return deleted;
    }
}

export const departmentService = new DepartmentService();
