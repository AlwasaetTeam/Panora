import { ITeamMapper } from '@ticketing/team/types';
import { ZendeskTeamInput, ZendeskTeamOutput } from './types';
import {
  UnifiedTeamInput,
  UnifiedTeamOutput,
} from '@ticketing/team/types/model.unified';
import { MappersRegistry } from '@@core/@core-services/registries/mappers.registry';
import { Injectable } from '@nestjs/common';
import { Utils } from '@ticketing/@lib/@utils';

@Injectable()
export class ZendeskTeamMapper implements ITeamMapper {
  constructor(private mappersRegistry: MappersRegistry, private utils: Utils) {
    this.mappersRegistry.registerService('ticketing', 'team', 'zendesk', this);
  }

  desunify(
    source: UnifiedTeamInput,
    customFieldMappings?: {
      slug: string;
      remote_id: string;
    }[],
  ): ZendeskTeamInput {
    return;
  }

  unify(
    source: ZendeskTeamOutput | ZendeskTeamOutput[],
    connectionId: string,
    customFieldMappings?: {
      slug: string;
      remote_id: string;
    }[],
  ): UnifiedTeamOutput | UnifiedTeamOutput[] {
    if (!Array.isArray(source)) {
      return this.mapSingleTeamToUnified(
        source,
        connectionId,
        customFieldMappings,
      );
    }
    return source.map((ticket) =>
      this.mapSingleTeamToUnified(ticket, connectionId, customFieldMappings),
    );
  }

  private mapSingleTeamToUnified(
    team: ZendeskTeamOutput,
    connectionId: string,
    customFieldMappings?: {
      slug: string;
      remote_id: string;
    }[],
  ): UnifiedTeamOutput {
    const unifiedTeam: UnifiedTeamOutput = {
      remote_id: String(team.id),
      name: team.name,
      description: team.description,
    };

    return unifiedTeam;
  }
}
