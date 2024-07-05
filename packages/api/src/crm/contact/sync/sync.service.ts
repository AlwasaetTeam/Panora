import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { LoggerService } from '@@core/@core-services/logger/logger.service';
import { PrismaService } from '@@core/@core-services/prisma/prisma.service';
import { ApiResponse } from '@@core/utils/types';
import { WebhookService } from '@@core/@core-services/webhooks/panora-webhooks/webhook.service';
import { UnifiedContactOutput } from '@crm/contact/types/model.unified';
import { CrmObject } from '@crm/@lib/@types';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { crm_contacts as CrmContact } from '@prisma/client';
import { IContactService } from '../types';
import { OriginalContactOutput } from '@@core/utils/types/original/original.crm';
import { ServiceRegistry } from '../services/registry.service';
import { CRM_PROVIDERS } from '@panora/shared';
import { Utils } from '@crm/@lib/@utils';
import { CoreSyncRegistry } from '@@core/@core-services/registries/core-sync.registry';
import { CoreUnification } from '@@core/@core-services/unification/core-unification.service';
import { BullQueueService } from '@@core/@core-services/queues/shared.service';
import { IBaseSync } from '@@core/utils/types/interface';
import { IngestDataService } from '@@core/@core-services/unification/ingest-data.service';

@Injectable()
export class SyncService implements OnModuleInit, IBaseSync {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private fieldMappingService: FieldMappingService,
    private webhook: WebhookService,
    private serviceRegistry: ServiceRegistry,
    private utils: Utils,
    private coreUnification: CoreUnification,
    private registry: CoreSyncRegistry,
    private bullQueueService: BullQueueService,
    private ingestService: IngestDataService,
  ) {
    this.logger.setContext(SyncService.name);
    this.registry.registerService('crm', 'contact', this);
  }

  async onModuleInit() {
    try {
      await this.bullQueueService.queueSyncJob(
        'crm-sync-contacts',
        '0 0 * * *',
      );
    } catch (error) {
      throw error;
    }
  }
  //function used by sync worker which populate our crm_contacts table
  //its role is to fetch all contacts from providers 3rd parties and save the info inside our db
  // @Cron('*/2 * * * *') // every 2 minutes (for testing)
  @Cron('0 */8 * * *') // every 8 hours
  async syncContacts(user_id?: string) {
    try {
      this.logger.log(`Syncing contacts....`);

      const users = user_id
        ? [
            await this.prisma.users.findUnique({
              where: {
                id_user: user_id,
              },
            }),
          ]
        : await this.prisma.users.findMany();
      if (users && users.length > 0) {
        for (const user of users) {
          const projects = await this.prisma.projects.findMany({
            where: {
              id_user: user.id_user,
            },
          });
          for (const project of projects) {
            const id_project = project.id_project;
            const linkedUsers = await this.prisma.linked_users.findMany({
              where: {
                id_project: id_project,
              },
            });
            linkedUsers.map(async (linkedUser) => {
              try {
                const providers = CRM_PROVIDERS.filter(
                  (provider) => provider !== 'zoho',
                );
                for (const provider of providers) {
                  try {
                    await this.syncContactsForLinkedUser(
                      provider,
                      linkedUser.id_linked_user,
                    );
                  } catch (error) {
                    throw error;
                  }
                }
              } catch (error) {
                throw error;
              }
            });
          }
        }
      }
    } catch (error) {
      throw error;
    }
  }

  //todo: HANDLE DATA REMOVED FROM PROVIDER
  async syncContactsForLinkedUser(integrationId: string, linkedUserId: string) {
    try {
      this.logger.log(
        `Syncing ${integrationId} contacts for linkedUser ${linkedUserId}`,
      );
      // check if linkedUser has a connection if not just stop sync
      const connection = await this.prisma.connections.findFirst({
        where: {
          id_linked_user: linkedUserId,
          provider_slug: integrationId,
          vertical: 'crm',
        },
      });
      if (!connection) {
        this.logger.warn(
          `Skipping contacts syncing... No ${integrationId} connection was found for linked user ${linkedUserId} `,
        );
      }
      // get potential fieldMappings and extract the original properties name
      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'crm.contact',
        );
      const remoteProperties: string[] = customFieldMappings.map(
        (mapping) => mapping.remote_id,
      );

      const service: IContactService =
        this.serviceRegistry.getService(integrationId);
      if (!service) return;
      const resp: ApiResponse<OriginalContactOutput[]> =
        await service.syncContacts(linkedUserId, remoteProperties);

      const sourceObject: OriginalContactOutput[] = resp.data;

      await this.ingestService.ingestData<
        OriginalContactOutput,
        OriginalContactOutput
      >(
        sourceObject,
        integrationId,
        connection.id_connection,
        'crm',
        'contact',
        customFieldMappings,
      );
    } catch (error) {
      throw error;
    }
  }

  async saveToDb(
    connection_id: string,
    linkedUserId: string,
    data: UnifiedContactOutput[],
    originSource: string,
    remote_data: Record<string, any>[],
  ): Promise<CrmContact[]> {
    try {
      let contacts_results: CrmContact[] = [];
      for (let i = 0; i < data.length; i++) {
        const contact = data[i];
        const originId = contact.remote_id;

        if (!originId || originId == '') {
          throw new ReferenceError(`Origin id not there, found ${originId}`);
        }

        const existingContact = await this.prisma.crm_contacts.findFirst({
          where: {
            remote_id: originId,
            id_connection: connection_id,
          },
          include: {
            crm_email_addresses: true,
            crm_phone_numbers: true,
            crm_addresses: true,
          },
        });

        const { normalizedEmails, normalizedPhones } =
          this.utils.normalizeEmailsAndNumbers(
            contact.email_addresses,
            contact.phone_numbers,
          );

        const normalizedAddresses = this.utils.normalizeAddresses(
          contact.addresses,
        );

        let unique_crm_contact_id: string;

        if (existingContact) {
          // Update the existing contact
          let data: any = {
            modified_at: new Date(),
            first_name: '',
            last_name: '',
          };

          if (contact.first_name) {
            data = { ...data, first_name: contact.first_name };
          }

          if (contact.last_name) {
            data = { ...data, last_name: contact.last_name };
          }

          if (contact.user_id) {
            data = {
              ...data,
              id_crm_user: contact.user_id,
            };
          }

          const res = await this.prisma.crm_contacts.update({
            where: {
              id_crm_contact: existingContact.id_crm_contact,
            },
            data: data,
          });

          if (normalizedEmails && normalizedEmails.length > 0) {
            await Promise.all(
              normalizedEmails.map((email, index) => {
                if (
                  existingContact &&
                  existingContact.crm_email_addresses[index]
                ) {
                  return this.prisma.crm_email_addresses.update({
                    where: {
                      id_crm_email:
                        existingContact.crm_email_addresses[index].id_crm_email,
                    },
                    data: email,
                  });
                } else {
                  return this.prisma.crm_email_addresses.create({
                    data: {
                      ...email,
                      id_crm_contact: existingContact.id_crm_contact, // Assuming 'uuid' is the ID of the related contact
                    },
                  });
                }
              }),
            );
          }
          if (normalizedPhones && normalizedPhones.length > 0) {
            await Promise.all(
              normalizedPhones.map((phone, index) => {
                if (
                  existingContact &&
                  existingContact.crm_phone_numbers[index]
                ) {
                  return this.prisma.crm_phone_numbers.update({
                    where: {
                      id_crm_phone_number:
                        existingContact.crm_phone_numbers[index]
                          .id_crm_phone_number,
                    },
                    data: phone,
                  });
                } else {
                  return this.prisma.crm_phone_numbers.create({
                    data: {
                      ...phone,
                      id_crm_contact: existingContact.id_crm_contact, // Assuming 'uuid' is the ID of the related contact
                    },
                  });
                }
              }),
            );
          }
          if (normalizedAddresses && normalizedAddresses.length > 0) {
            await Promise.all(
              normalizedAddresses.map((addy, index) => {
                if (existingContact && existingContact.crm_addresses[index]) {
                  return this.prisma.crm_addresses.update({
                    where: {
                      id_crm_address:
                        existingContact.crm_addresses[index].id_crm_address,
                    },
                    data: addy,
                  });
                } else {
                  return this.prisma.crm_addresses.create({
                    data: {
                      ...addy,
                      id_crm_contact: existingContact.id_crm_contact, // Assuming 'uuid' is the ID of the related contact
                    },
                  });
                }
              }),
            );
          }

          unique_crm_contact_id = res.id_crm_contact;
          contacts_results = [...contacts_results, res];
        } else {
          // Create a new contact
          this.logger.log('not existing contact ' + contact.first_name);
          const uuid = uuidv4();
          let data: any = {
            id_crm_contact: uuid,
            first_name: '',
            last_name: '',
            created_at: new Date(),
            modified_at: new Date(),
            remote_id: originId,
            id_connection: connection_id,
          };

          if (contact.first_name) {
            data = { ...data, first_name: contact.first_name };
          }
          if (contact.last_name) {
            data = { ...data, last_name: contact.last_name };
          }
          if (contact.user_id) {
            data = {
              ...data,
              id_crm_user: contact.user_id,
            };
          }

          const newContact = await this.prisma.crm_contacts.create({
            data: data,
          });

          if (normalizedEmails && normalizedEmails.length > 0) {
            await Promise.all(
              normalizedEmails.map((email) =>
                this.prisma.crm_email_addresses.create({
                  data: {
                    ...email,
                    id_crm_contact: newContact.id_crm_contact,
                  },
                }),
              ),
            );
          }

          if (normalizedPhones && normalizedPhones.length > 0) {
            await Promise.all(
              normalizedPhones.map((phone) =>
                this.prisma.crm_phone_numbers.create({
                  data: {
                    ...phone,
                    id_crm_contact: newContact.id_crm_contact,
                  },
                }),
              ),
            );
          }

          if (normalizedAddresses && normalizedAddresses.length > 0) {
            await Promise.all(
              normalizedAddresses.map((addy) =>
                this.prisma.crm_addresses.create({
                  data: {
                    ...addy,
                    id_crm_contact: newContact.id_crm_contact,
                  },
                }),
              ),
            );
          }

          unique_crm_contact_id = newContact.id_crm_contact;
          contacts_results = [...contacts_results, newContact];
        }
        // check duplicate or existing values
        if (contact.field_mappings && contact.field_mappings.length > 0) {
          const entity = await this.prisma.entity.create({
            data: {
              id_entity: uuidv4(),
              ressource_owner_id: unique_crm_contact_id,
            },
          });

          for (const [slug, value] of Object.entries(contact.field_mappings)) {
            const attribute = await this.prisma.attribute.findFirst({
              where: {
                slug: slug,
                source: originSource,
                id_consumer: linkedUserId,
              },
            });

            if (attribute) {
              await this.prisma.value.create({
                data: {
                  id_value: uuidv4(),
                  data: value || 'null',
                  attribute: {
                    connect: {
                      id_attribute: attribute.id_attribute,
                    },
                  },
                  entity: {
                    connect: {
                      id_entity: entity.id_entity,
                    },
                  },
                },
              });
            }
          }
        }

        //insert remote_data in db
        await this.prisma.remote_data.upsert({
          where: {
            ressource_owner_id: unique_crm_contact_id,
          },
          create: {
            id_remote_data: uuidv4(),
            ressource_owner_id: unique_crm_contact_id,
            format: 'json',
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
          update: {
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
        });
      }
      return contacts_results;
    } catch (error) {
      throw error;
    }
  }
}
