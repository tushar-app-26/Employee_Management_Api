
import { Router, type RequestHandler } from "express";
import { employeeController } from "../controllers/employee.controller.js";
import { validateRequest } from "../middlewares/validate-request.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/authorize.js";
import { documentUpload } from "../middlewares/document-upload.js";
import { documentController } from "../controllers/document.controller.js";
import { documentListQuerySchema } from "../validators/document.validator.js";

import {
    createEmployeeSchema,
    updateEmployeeSchema,
    employeeIdSchema,
    employeeListQuerySchema,
    updateOwnEmployeeSchema,
} from "../validators/employee.validator.js";

const router = Router();

const requireDeactivationPermission = requirePermission("employee:deactivate");
const requirePermissionForDisablingStatus: RequestHandler = (req, res, next) => {
    const status = req.body?.employmentStatus;
    if (status === "inactive" || status === "terminated") {
        return requireDeactivationPermission(req, res, next);
    }
    return next();
};

// Har employee route ke liye valid JWT required hai.
router.use(authenticate);

// Employees list
router.get(
    "/",
    requirePermission("employee:list"),
    validateRequest(employeeListQuerySchema, "query"),
    (req, res, next) => employeeController.getAll(req, res, next),
);

router.get(
    "/me/export",
    requirePermission("employee:export:self"),
    (req, res, next) => employeeController.exportMe(req, res, next),
);
router.get(
    "/me",
    requirePermission("employee:read:self"),
    (req, res, next) => employeeController.getMe(req, res, next),
);
router.patch(
    "/me",
    requirePermission("employee:update:self"),
    validateRequest(updateOwnEmployeeSchema),
    (req, res, next) => employeeController.updateMe(req, res, next),
);

// Employee document management
router.post(
    "/:id/documents",
    requirePermission("document:upload"),
    validateRequest(employeeIdSchema, "params"),
    documentUpload.single("document"),
    (req, res, next) => documentController.upload(req, res, next),
);
router.get(
    "/:id/documents",
    requirePermission("document:list"),
    validateRequest(employeeIdSchema, "params"),
    validateRequest(documentListQuerySchema, "query"),
    (req, res, next) => documentController.list(req, res, next),
);

// Single employee
router.get(
    "/:id",
    requirePermission("employee:read:any", "employee:read:reports"),
    validateRequest(employeeIdSchema, "params"),
    (req, res, next) => employeeController.getById(req, res, next),
);

// Create employee
router.post(
    "/",
    requirePermission("employee:create"),
    requirePermission("employee:link-account"),
    validateRequest(createEmployeeSchema),
    (req, res, next) => employeeController.create(req, res, next),
);

// Update employee
router.patch(
    "/:id",
    requirePermission("employee:update:any", "employee:update:reports"),
    validateRequest(employeeIdSchema, "params"),
    validateRequest(updateEmployeeSchema),
    requirePermissionForDisablingStatus,
    (req, res, next) => employeeController.update(req, res, next),
);

// Delete employee
router.delete(
    "/:id",
    requirePermission("employee:deactivate"),
    validateRequest(employeeIdSchema, "params"),
    (req, res, next) => employeeController.delete(req, res, next),
);

export default router;
