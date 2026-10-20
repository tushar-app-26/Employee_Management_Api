import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { EmployeeEntity } from "./employee.entity.js";
import { UserEntity } from "./user.entity.js";

@Entity({ name: "employee_documents" })
export class EmployeeDocumentEntity {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ name: "employee_id", type: "uuid" })
    employeeId!: string;

    @ManyToOne(() => EmployeeEntity, { onDelete: "CASCADE" })
    @JoinColumn({ name: "employee_id" })
    employee!: EmployeeEntity;

    @Column({ name: "uploaded_by_user_id", type: "uuid", nullable: true })
    uploadedByUserId!: string | null;

    @ManyToOne(() => UserEntity, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "uploaded_by_user_id" })
    uploadedBy!: UserEntity | null;

    @Column({ name: "original_filename", type: "varchar", length: 255 })
    originalFilename!: string;

    @Column({ name: "storage_filename", type: "varchar", length: 100, unique: true })
    storageFilename!: string;

    @Column({ name: "mime_type", type: "varchar", length: 100 })
    mimeType!: string;

    @Column({ name: "size_bytes", type: "integer" })
    sizeBytes!: number;

    @CreateDateColumn({ name: "created_at", type: "timestamptz" })
    createdAt!: Date;
}
