import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class UnifiedCrmUserInput {
  @ApiProperty({
    type: String,
    description: 'The name of the user',
    nullable: true,
  })
  @IsString()
  name: string;

  @ApiProperty({
    type: String,
    description: 'The email of the user',
    nullable: true,
  })
  @IsString()
  email: string;

  @ApiPropertyOptional({
    type: Object,
    description:
      'The custom field mappings of the user between the remote 3rd party & Panora',
    nullable: true,
    additionalProperties: true,
  })
  @IsOptional()
  field_mappings?: Record<string, any>;
}

export class UnifiedCrmUserOutput extends UnifiedCrmUserInput {
  @ApiPropertyOptional({
    type: String,
    description: 'The UUID of the user',
    nullable: true,
  })
  @IsUUID()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'The id of the user in the context of the Crm 3rd Party',
    nullable: true,
  })
  @IsString()
  @IsOptional()
  remote_id?: string;

  @ApiPropertyOptional({
    type: Object,
    description:
      'The remote data of the user in the context of the Crm 3rd Party',
    nullable: true,
    additionalProperties: true,
  })
  @IsOptional()
  remote_data?: Record<string, any>;

  @ApiPropertyOptional({
    type: Date,
    description: 'The created date of the object',
    nullable: true,
  })
  @IsOptional()
  created_at?: Date;

  @ApiPropertyOptional({
    type: Date,
    description: 'The modified date of the object',
    nullable: true,
  })
  @IsOptional()
  modified_at?: Date;
}
