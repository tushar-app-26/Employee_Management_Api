import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToOne,
    JoinColumn,
} from "typeorm";

import { DepartmentEntity } from "./department.entity.js";
import { UserEntity } from "./user.entity.js";

export type EmploymentStatus =
    | "active"
    | "inactive"
    | "on_leave"
    | "terminated";

@Entity({ name: "employees" })
export class EmployeeEntity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // Legacy columns retained for existing employees that have not been linked
    // to a registered user yet. New employee records use the linked user name.
    @Column({ name: "first_name", type: "varchar", length: 100, nullable: true })
    firstName!: string | null;

    @Column({ name: "last_name", type: "varchar", length: 100, nullable: true })
    lastName!: string | null;

    @Column({ name: "user_id", type: "uuid", nullable: true, unique: true })
    userId!: string | null;

    @OneToOne(() => UserEntity, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "user_id" })
    user!: UserEntity | null;

    @Column({ name: "work_email", type: "varchar", unique: true })
    workEmail!: string;

    @Column({ type: "varchar", nullable: true })
    phone!: string | null;

    @Column({ name: "department_id", type: "uuid" })
    departmentId!: string;

    @ManyToOne(() => DepartmentEntity, {
        nullable: false,
        onDelete: "RESTRICT",
    })
    @JoinColumn({ name: "department_id" })
    department!: DepartmentEntity;

    @Column({ name: "manager_id", type: "uuid", nullable: true })
    managerId!: string | null;

    @ManyToOne(() => EmployeeEntity, {
        nullable: true,
        onDelete: "SET NULL",
    })
    @JoinColumn({ name: "manager_id" })
    manager!: EmployeeEntity | null;

    @Column({ name: "job_title", type: "varchar" })
    jobTitle!: string;

    @Column({ name: "joining_date", type: "date" })
    joiningDate!: string;

    @Column({
        name: "employment_status",
        type: "varchar",
        length: 20,
        default: "active",
    })
    employmentStatus!: EmploymentStatus;

    @CreateDateColumn({ name: "created_at", type: "timestamptz" })
    createdAt!: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
    updatedAt!: Date;
}
