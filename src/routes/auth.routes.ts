import { Router } from "express";
import { authController } from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { validateRequest } from "../middlewares/validate-request.js";
import { paginationQuerySchema } from "../validators/pagination.validator.js";
import {
    registerSchema,
    loginSchema,
    refreshTokenSchema,
    logoutSchema,
    sessionIdSchema,
    changePasswordSchema,
} from "../validators/auth.validator.js";

const router = Router();

router.post(
    "/register",
    validateRequest(registerSchema),
    authController.register.bind(authController),
);

router.post(
    "/login",
    validateRequest(loginSchema),
    authController.login.bind(authController),
);

router.post(
    "/refresh",
    validateRequest(refreshTokenSchema),
    authController.refresh.bind(authController),
);

router.post(
    "/logout",
    validateRequest(logoutSchema),
    authController.logout.bind(authController),
);

router.post(
    "/logout-all",
    authenticate,
    authController.logoutAll.bind(authController),
);

router.get(
    "/sessions",
    authenticate,
    validateRequest(paginationQuerySchema, "query"),
    authController.sessions.bind(authController),
);

router.get(
    "/sessions/history",
    authenticate,
    validateRequest(paginationQuerySchema, "query"),
    authController.sessionHistory.bind(authController),
);

router.get(
    "/sessions/:id",
    authenticate,
    validateRequest(sessionIdSchema, "params"),
    authController.sessionById.bind(authController),
);

router.delete(
    "/sessions/:id",
    authenticate,
    validateRequest(sessionIdSchema, "params"),
    authController.revokeSession.bind(authController),
);

router.post(
    "/change-password",
    authenticate,
    validateRequest(changePasswordSchema),
    authController.changePassword.bind(authController),
);

export default router;


