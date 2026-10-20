
import { AppDataSource } from "../config/database.js";
import { UserEntity } from "../entities/user.entity.js";

export const userRepository =
    AppDataSource.getRepository(UserEntity);
