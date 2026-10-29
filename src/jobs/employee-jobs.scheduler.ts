import cron from "node-cron";
import { employeeScheduledJobsService } from "../services/employee-scheduled-jobs.service.js";

export const ENGINEERING_EMPLOYEE_CRON = "0 * * * *";
export const MISSING_PHONE_CRON = "*/15 * * * *";
export const EMPLOYEE_JOBS_TIMEZONE = "UTC";

type EmployeeJobFunctions = Pick<
    typeof employeeScheduledJobsService,
    "logEngineeringEmployees" | "logEmployeesWithMissingPhoneNumbers"
>;

let scheduledTasks: Array<ReturnType<typeof cron.schedule>> = [];

function nonOverlappingTask(name: string, job: () => Promise<unknown>): () => Promise<void> {
    let running = false;
    return async () => {
        if (running) {
            console.warn(`Skipping overlapping scheduled job: ${name}`);
            return;
        }

        running = true;
        try {
            await job();
        } catch (error) {
            console.error(`Scheduled job failed: ${name}`, error);
        } finally {
            running = false;
        }
    };
}

export function startEmployeeJobs(
    jobs: EmployeeJobFunctions = employeeScheduledJobsService,
    schedule: typeof cron.schedule = cron.schedule,
): void {
    if (scheduledTasks.length > 0) return;

    const engineeringTask = nonOverlappingTask(
        "engineering-employee-logging",
        () => jobs.logEngineeringEmployees(),
    );
    const missingPhoneTask = nonOverlappingTask(
        "missing-phone-employee-logging",
        () => jobs.logEmployeesWithMissingPhoneNumbers(),
    );

    scheduledTasks = [
        schedule(ENGINEERING_EMPLOYEE_CRON, engineeringTask, { timezone: EMPLOYEE_JOBS_TIMEZONE }),
        schedule(MISSING_PHONE_CRON, missingPhoneTask, { timezone: EMPLOYEE_JOBS_TIMEZONE }),
    ];
}

export function stopEmployeeJobs(): void {
    for (const task of scheduledTasks) task.stop();
    scheduledTasks = [];
}
