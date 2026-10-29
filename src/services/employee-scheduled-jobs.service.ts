import type { DataSource } from "typeorm";
import { AppDataSource } from "../config/database.js";
import { EmployeeEntity } from "../entities/employee.entity.js";
import { auditService, type AuditService } from "./audit.service.js";

export const ENGINEERING_EMPLOYEE_ACTION = "Engineering employee detected";
export const MISSING_PHONE_ACTION = "Employee phone number missing";

export function scheduledRunId(job: "engineering" | "missing-phone", runAt: Date): string {
    const intervalMs = (job === "engineering" ? 60 : 15) * 60 * 1000;
    const runSlot = Math.floor(runAt.getTime() / intervalMs) * intervalMs;
    return `scheduled:${job}:${new Date(runSlot).toISOString()}`;
}

export class EmployeeScheduledJobsService {
    constructor(
        private readonly dataSource: DataSource = AppDataSource,
        private readonly audit: AuditService = auditService,
    ) {}

    async logEngineeringEmployees(runAt = new Date()): Promise<number> {
        const employees = await this.dataSource.getRepository(EmployeeEntity)
            .createQueryBuilder("employee")
            .innerJoin("employee.department", "department")
            .select("employee.id", "id")
            .where("department.name = :departmentName", { departmentName: "Engineering" })
            .getRawMany<{ id: string }>();

        const requestId = scheduledRunId("engineering", runAt);
        for (const employee of employees) {
            await this.audit.recordOnce({
                actorUserId: null,
                action: ENGINEERING_EMPLOYEE_ACTION,
                resourceType: "employee",
                resourceId: employee.id,
                requestId,
                details: { scheduledRunId: requestId },
            });
        }
        return employees.length;
    }

    async logEmployeesWithMissingPhoneNumbers(runAt = new Date()): Promise<number> {
        const employees = await this.dataSource.getRepository(EmployeeEntity)
            .createQueryBuilder("employee")
            .select("employee.id", "id")
            .where("employee.phone IS NULL OR employee.phone ~ '^[[:space:]]*$'")
            .getRawMany<{ id: string }>();

        const requestId = scheduledRunId("missing-phone", runAt);
        for (const employee of employees) {
            await this.audit.recordOnce({
                actorUserId: null,
                action: MISSING_PHONE_ACTION,
                resourceType: "employee",
                resourceId: employee.id,
                requestId,
                details: { scheduledRunId: requestId },
            });
        }
        return employees.length;
    }
}

export const employeeScheduledJobsService = new EmployeeScheduledJobsService();
