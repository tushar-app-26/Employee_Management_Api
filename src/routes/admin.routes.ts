import { Router } from "express";
import { adminController } from "../controllers/admin.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/authorize.js";

const router = Router();
router.get("/session-metrics", authenticate, requirePermission("session:metrics"), adminController.sessionMetrics.bind(adminController));

export default router;
