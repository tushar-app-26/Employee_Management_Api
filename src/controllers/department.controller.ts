import type { Request, Response, NextFunction } from "express";
import { departmentService } from "../services/department.service.js";
import { ApiResponse } from "../utils/api-response.js";
import type { DepartmentListQuery } from "../validators/department.validator.js";

export class DepartmentController {
    async getAll(
        _req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const query = res.locals.validatedQuery as DepartmentListQuery;
            const result = await departmentService.getAllDepartments(query);

            ApiResponse.send(
                res,
                200,
                "Departments fetched successfully",
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
            const department = await departmentService.getDepartmentById(
                req.params.id as string,
            );

            if (!department) {
                ApiResponse.send(res, 404, "Department not found", null);
                return;
            }

            ApiResponse.send(
                res,
                200,
                "Department fetched successfully",
                department,
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
            const department = await departmentService.createDepartment(req.body, req.auth?.sub, String(res.locals.requestId ?? ""));
            ApiResponse.send(res, 201, "Department created successfully", department);
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
            const department = await departmentService.updateDepartment(
                req.params.id as string,
                req.body,
                req.auth?.sub,
                String(res.locals.requestId ?? ""),
            );

            if (!department) {
                ApiResponse.send(res, 404, "Department not found", null);
                return;
            }

            ApiResponse.send(res, 200, "Department updated successfully", department);
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
            const deleted = await departmentService.deleteDepartment(
                req.params.id as string,
                req.auth?.sub,
                String(res.locals.requestId ?? ""),
            );

            if (!deleted) {
                ApiResponse.send(res, 404, "Department not found", null);
                return;
            }

            ApiResponse.send(res, 200, "Department deleted successfully", null);
        } catch (error) {
            next(error);
        }
    }
}

export const departmentController = new DepartmentController();
