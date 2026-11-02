
function defaultCodeForStatus(statusCode: number): string {
    if (statusCode === 400) return "BAD_REQUEST";
    if (statusCode === 401) return "UNAUTHENTICATED";
    if (statusCode === 403) return "FORBIDDEN";
    if (statusCode === 404) return "NOT_FOUND";
    if (statusCode === 409) return "CONFLICT";
    if (statusCode === 429) return "RATE_LIMITED";
    if (statusCode >= 500) return "INTERNAL_ERROR";
    return "APPLICATION_ERROR";
}

export class AppError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string,
        public readonly code = defaultCodeForStatus(statusCode),
        options?: ErrorOptions,
    ) {
        super(message, options);

        this.name = "AppError";

        Object.setPrototypeOf(this, new.target.prototype);
    }
}
