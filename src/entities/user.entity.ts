import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
} from "typeorm";

export type UserRole = "admin" | "hr" | "manager" | "employee";

@Entity({ name: "users" })
export class UserEntity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ name: "first_name", type: "varchar", length: 100, nullable: true })
    firstName!: string | null;

    @Column({ name: "last_name", type: "varchar", length: 100, nullable: true })
    lastName!: string | null;

    @Column({
        name: "email",
        type: "varchar",
        length: 255,
        unique: true,
    })
    email!: string;

    @Column({
        name: "password_hash",
        type: "varchar",
        length: 255,
        select: false,
    })
    passwordHash!: string;

    @Column({
        name: "role_id",
        type: "varchar",
        length: 20,
        default: "employee",
    })
    role!: UserRole;

    @Column({ name: "is_active", type: "boolean", default: true })
    isActive!: boolean;

    @CreateDateColumn({
        name: "created_at",
        type: "timestamptz",
    })
    createdAt!: Date;

    @UpdateDateColumn({
        name: "updated_at",
        type: "timestamptz",
    })
    updatedAt!: Date;
}
