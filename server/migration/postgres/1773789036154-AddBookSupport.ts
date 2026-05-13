import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookSupport1773789036154 implements MigrationInterface {
  name = 'AddBookSupport1773789036154';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "readarrServiceId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" ADD "metadataProfileId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "metadataProfileId" integer`
    );
    await queryRunner.query(`ALTER TABLE "user" ADD "bookQuotaLimit" integer`);
    await queryRunner.query(`ALTER TABLE "user" ADD "bookQuotaDays" integer`);
    await queryRunner.query(
      `ALTER TABLE "user" ALTER COLUMN "permissions" TYPE bigint`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ALTER COLUMN "permissions" TYPE integer`
    );
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "bookQuotaDays"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "bookQuotaLimit"`);
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "metadataProfileId"`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "metadataProfileId"`
    );
    await queryRunner.query(
      `ALTER TABLE "override_rule" DROP COLUMN "readarrServiceId"`
    );
  }
}
