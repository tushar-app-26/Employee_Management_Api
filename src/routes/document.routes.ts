import { Router } from "express";
import { documentController } from "../controllers/document.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/authorize.js";
import { validateRequest } from "../middlewares/validate-request.js";
import { documentIdSchema } from "../validators/document.validator.js";

const router = Router();

router.get("/:id/download", (req, res, next) => documentController.download(req, res, next));
router.use(authenticate);

router.get(
    "/:id/download-url",
    requirePermission("document:download"),
    validateRequest(documentIdSchema, "params"),
    (req, res, next) => documentController.createDownloadUrl(req, res, next),
);
router.delete(
    "/:id",
    requirePermission("document:delete"),
    validateRequest(documentIdSchema, "params"),
    (req, res, next) => documentController.delete(req, res, next),
);

export default router;
