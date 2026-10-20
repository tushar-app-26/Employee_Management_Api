import { randomUUID } from "node:crypto";
import type {
    Request,
    Response,
    NextFunction
} from "express";

export function requestIdMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction
): void {
    const id = randomUUID();

    res.setHeader("X-Request-ID", id);
    res.locals.requestId = id;

    next();
}