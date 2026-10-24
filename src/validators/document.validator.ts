import { z } from "zod";
import { paginationQuerySchema } from "./pagination.validator.js";

export const documentIdSchema = z.object({ id: z.string().uuid("Invalid document ID") }).strict();
export const documentListQuerySchema = paginationQuerySchema;
