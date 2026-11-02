import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config/config.js";
import { AppError } from "../errors/app-error.js";
import { storageDirectory } from "../middlewares/document-upload.js";

const s3Client = config.DOCUMENT_STORAGE_DRIVER === "s3"
    ? new S3Client({
        region: config.AWS_REGION,
        ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
            ? { credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY } }
            : {}),
        maxAttempts: 2,
        requestHandler: new NodeHttpHandler({
            connectionTimeout: config.S3_REQUEST_TIMEOUT_MS,
            socketTimeout: config.S3_REQUEST_TIMEOUT_MS,
        }),
    })
    : undefined;

export class DocumentStorage {
    async put(key: string, body: Buffer, contentType: string) {
        if (s3Client) {
            await s3Client.send(new PutObjectCommand({
                Bucket: config.AWS_S3_BUCKET,
                Key: key,
                Body: body,
                ContentType: contentType,
                ServerSideEncryption: "AES256",
            }));
            return;
        }
        await mkdir(storageDirectory, { recursive: true });
        await writeFile(resolve(storageDirectory, key), body, { flag: "wx", mode: 0o600 });
    }

    async delete(key: string) {
        if (s3Client) {
            await s3Client.send(new DeleteObjectCommand({ Bucket: config.AWS_S3_BUCKET, Key: key }));
            return;
        }
        await unlink(resolve(storageDirectory, key));
    }

    async presignedDownloadUrl(key: string, filename: string, contentType: string) {
        if (!s3Client) return undefined;
        return getSignedUrl(s3Client, new GetObjectCommand({
            Bucket: config.AWS_S3_BUCKET,
            Key: key,
            ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
            ResponseContentType: contentType,
            ResponseCacheControl: "private, no-store",
        }), { expiresIn: config.S3_PRESIGNED_URL_TTL_SECONDS });
    }

    getLocalPath(key: string) {
        if (s3Client) throw new AppError(500, "Local document path is unavailable for S3 storage");
        return resolve(storageDirectory, key);
    }

    get usesS3() {
        return Boolean(s3Client);
    }
}

export const documentStorage = new DocumentStorage();
