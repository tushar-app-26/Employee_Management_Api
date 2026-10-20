
import { AppDataSource } from "../config/database.js";
import { DepartmentEntity } from "../entities/department.entity.js";

export const departmentRepository =
    AppDataSource.getRepository(DepartmentEntity);
