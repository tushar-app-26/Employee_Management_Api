import cron from "node-cron";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
    EMPLOYEE_JOBS_TIMEZONE,
    ENGINEERING_EMPLOYEE_CRON,
    MISSING_PHONE_CRON,
    startEmployeeJobs,
    stopEmployeeJobs,
} from "../src/jobs/employee-jobs.scheduler.js";
import type { ScheduledTask, TaskFn, TaskOptions } from "node-cron";

const fakeTask = { stop: vi.fn() } as unknown as ScheduledTask;

function mockSchedule(callbacks: TaskFn[]) {
    return vi.fn((expression: string, task: string | TaskFn, _options?: TaskOptions): ScheduledTask => {
        if (typeof task === "function") callbacks.push(task);
        return fakeTask;
    });
}

afterEach(() => {
    stopEmployeeJobs();
    vi.restoreAllMocks();
});

describe("employee scheduled jobs scheduler", () => {
    test("registers both required expressions in UTC and only once", () => {
        const callbacks: TaskFn[] = [];
        const schedule = mockSchedule(callbacks);
        const jobs = {
            logEngineeringEmployees: vi.fn().mockResolvedValue(0),
            logEmployeesWithMissingPhoneNumbers: vi.fn().mockResolvedValue(0),
        };

        startEmployeeJobs(jobs, schedule as unknown as typeof cron.schedule);
        startEmployeeJobs(jobs, schedule as unknown as typeof cron.schedule);

        expect(schedule).toHaveBeenCalledTimes(2);
        expect(schedule.mock.calls.map(([expression]) => expression)).toEqual([
            ENGINEERING_EMPLOYEE_CRON,
            MISSING_PHONE_CRON,
        ]);
        expect(schedule.mock.calls.every(([, , options]) => options?.timezone === EMPLOYEE_JOBS_TIMEZONE)).toBe(true);
        expect(EMPLOYEE_JOBS_TIMEZONE).toBe("UTC");
    });

    test("prevents overlapping executions of the same job", async () => {
        const callbacks: TaskFn[] = [];
        const schedule = mockSchedule(callbacks);
        let releaseJob!: (value: number) => void;
        const runningJob = new Promise<number>((resolve) => { releaseJob = resolve; });
        const jobs = {
            logEngineeringEmployees: vi.fn(() => runningJob),
            logEmployeesWithMissingPhoneNumbers: vi.fn(async () => 0),
        };
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        startEmployeeJobs(jobs, schedule as unknown as typeof cron.schedule);

        const firstRun = callbacks[0]!({} as Parameters<TaskFn>[0]);
        await callbacks[0]!({} as Parameters<TaskFn>[0]);
        expect(jobs.logEngineeringEmployees).toHaveBeenCalledTimes(1);
        releaseJob(1);
        await firstRun;
    });

    test("a failure in one job is logged and does not prevent the other job", async () => {
        const callbacks: TaskFn[] = [];
        const schedule = mockSchedule(callbacks);
        const jobs = {
            logEngineeringEmployees: vi.fn(async () => { throw new Error("database error"); }),
            logEmployeesWithMissingPhoneNumbers: vi.fn(async () => 2),
        };
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        startEmployeeJobs(jobs, schedule as unknown as typeof cron.schedule);

        await callbacks[0]!({} as Parameters<TaskFn>[0]);
        await callbacks[1]!({} as Parameters<TaskFn>[0]);

        expect(error).toHaveBeenCalledOnce();
        expect(jobs.logEmployeesWithMissingPhoneNumbers).toHaveBeenCalledOnce();
    });
});
