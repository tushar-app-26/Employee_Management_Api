import pino from "pino";
import { config } from "../config/config.js";

export const logger = pino({
    level: config.LOG_LEVEL,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
});
