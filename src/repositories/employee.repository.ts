
import { AppDataSource } from "../config/database.js";
import { EmployeeEntity } from "../entities/employee.entity.js";

export const employeeRepository =
    AppDataSource.getRepository(EmployeeEntity);
