
import { AppDataSource } from "../config/database.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";

export const refreshTokenRepository =
    AppDataSource.getRepository(RefreshTokenEntity);