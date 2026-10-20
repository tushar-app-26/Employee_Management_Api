import { Router } from "express";
import { userController } from "../controllers/user.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/authorize.js";
import { validateRequest } from "../middlewares/validate-request.js";
import { updateUserAccessSchema, userIdSchema } from "../validators/user.validator.js";

const router = Router();

router.use(authenticate);
router.get(
    "/unlinked-employees",
    requirePermission("user:read-unlinked"),
    (req, res, next) => userController.getUnlinkedEmployeeUsers(req, res, next),
);

router.patch(
    "/:id/access",
    requirePermission("user:manage"),
    validateRequest(userIdSchema, "params"),
    validateRequest(updateUserAccessSchema),
    (req, res, next) => userController.updateAccess(req, res, next),
);

router.delete(
    "/:id/sessions",
    requirePermission("user:manage"),
    validateRequest(userIdSchema, "params"),
    (req, res, next) => userController.revokeSessions(req, res, next),
);

export default router;
