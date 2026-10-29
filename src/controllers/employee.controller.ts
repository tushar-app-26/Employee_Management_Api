import type { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../utils/api-response.js";
import { employeeService } from "../services/employee.service.js";
import type { EmployeeListQuery } from "../validators/employee.validator.js";

export class EmployeeController {
    async getAll(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const query = res.locals.validatedQuery as EmployeeListQuery;
            const result = await employeeService.getAllEmployees(query, req.auth);

            ApiResponse.send(
                res,
                200,
                "Employees fetched successfully",
                result,
            );
        } catch (error) {
            next(error);
        }
    }

    async getById(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const employee = await employeeService.getEmployeeById(
                req.params.id as string,
                req.auth,
            );

            if (!employee) {
                ApiResponse.send(res, 404, "Employee not found", null);
                return;
            }

            ApiResponse.send(
                res,
                200,
                "Employee fetched successfully",
                employee,
            );
        } catch (error) {
            next(error);
        }
    }

    async create(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const employee = await employeeService.createEmployee(
                req.body,
                req.auth?.sub,
                String(res.locals.requestId ?? ""),
                req.get("Idempotency-Key"),
            );
            if (employee.replayed) res.setHeader("Idempotency-Replayed", "true");

            ApiResponse.send(
                res,
                201,
                "Employee created successfully",
                employee.value,
            );
        } catch (error) {
            next(error);
        }
    }

    async update(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const employee = await employeeService.updateEmployee(
                req.params.id as string,
                req.body,
                req.auth!,
                String(res.locals.requestId ?? ""),
            );

            if (!employee) {
                ApiResponse.send(res, 404, "Employee not found", null);
                return;
            }

            ApiResponse.send(
                res,
                200,
                "Employee updated successfully",
                employee,
            );
        } catch (error) {
            next(error);
        }
    }

    async delete(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const deactivated = await employeeService.deleteEmployee(
                req.params.id as string,
                req.auth?.sub,
                String(res.locals.requestId ?? ""),
            );

            if (!deactivated) {
                ApiResponse.send(res, 404, "Employee not found", null);
                return;
            }

            ApiResponse.send(
                res,
                200,
                "Employee deactivated successfully",
                null,
            );
        } catch (error) {
            next(error);
        }
    }

    async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const employee = await employeeService.getMyEmployee(req.auth!.sub);
            if (!employee) {
                ApiResponse.send(res, 404, "Employee profile not found", null);
                return;
            }
            ApiResponse.send(res, 200, "Your employee profile fetched successfully", employee);
        } catch (error) { next(error); }
    }

    async updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const employee = await employeeService.updateMyEmployee(
                req.auth!.sub,
                req.body,
                String(res.locals.requestId ?? ""),
            );
            ApiResponse.send(res, 200, "Your permitted profile fields were updated", employee);
        } catch (error) { next(error); }
    }

    async exportMe(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = await employeeService.exportMyData(
                req.auth!.sub,
                String(res.locals.requestId ?? ""),
            );
            ApiResponse.send(res, 200, "Your profile data was exported", data);
        } catch (error) { next(error); }
    }
}

export const employeeController = new EmployeeController();
