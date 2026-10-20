
import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/authorize.js";
import { departmentController } from "../controllers/department.controller.js";
import { validateRequest } from "../middlewares/validate-request.js";
import {
    createDepartmentSchema,
    updateDepartmentSchema,
    departmentIdSchema,
    departmentListQuerySchema,
} from "../validators/department.validator.js";

const router = Router();

router.use(authenticate);

router.get(
    "/",
    requirePermission("department:read"),
    validateRequest(departmentListQuerySchema, "query"),
    (req, res, next) => departmentController.getAll(req, res, next),
);

router.get(
    "/:id",
    requirePermission("department:read"),
    validateRequest(departmentIdSchema, "params"),
    (req, res, next) => departmentController.getById(req, res, next),
);

router.post(
    "/",
    requirePermission("department:manage"),
    validateRequest(createDepartmentSchema),
    (req, res, next) => departmentController.create(req, res, next),
);

router.patch(
    "/:id",
    requirePermission("department:manage"),
    validateRequest(departmentIdSchema, "params"),
    validateRequest(updateDepartmentSchema),
    (req, res, next) => departmentController.update(req, res, next),
);

router.delete(
    "/:id",
    requirePermission("department:manage"),
    validateRequest(departmentIdSchema, "params"),
    (req, res, next) => departmentController.delete(req, res, next),
);

export default router;
