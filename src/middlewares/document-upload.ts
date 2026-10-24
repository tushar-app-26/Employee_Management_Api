import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import multer from "multer";
import { config } from "../config/config.js";
import { AppError } from "../errors/app-error.js";

const storageDirectory = resolve(process.cwd(), config.DOCUMENT_STORAGE_DIR);
const acceptedTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
};

export const documentUpload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (_req, file, callback) => {
        const extension = extname(file.originalname).toLowerCase();
        if (!acceptedTypes[extension] || acceptedTypes[extension] !== file.mimetype) {
            callback(new AppError(400, "Only matching PDF, PNG, and JPEG documents are accepted"));
            return;
        }
        callback(null, true);
    },
    limits: { fileSize: config.DOCUMENT_MAX_SIZE_MB * 1024 * 1024, files: 1, fields: 5 },
});

export function createStorageFilename(originalName: string) {
    return `${randomUUID()}${extname(originalName).toLowerCase()}`;
}

export { acceptedTypes, storageDirectory };
