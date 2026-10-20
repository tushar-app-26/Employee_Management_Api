
import type {
    Request,
    Response,
    NextFunction,
    RequestHandler,
} from "express";
import type { ZodType } from "zod";
import { ApiResponse } from "../utils/api-response.js";

type RequestPart = "body" | "params" | "query";

export function validateRequest(
    schema: ZodType,
    part: RequestPart = "body",
): RequestHandler {
    return (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        const result = schema.safeParse(req[part]);

        if (!result.success) {
            ApiResponse.send(
                res,
                400,
                "Request validation failed",
                result.error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            );
            return;
        }

        if (part === "body") {
            req.body = result.data;
        } else if (part === "query") {
            res.locals.validatedQuery = result.data;
        }

        next();
    };
}
