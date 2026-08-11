import { Router } from 'express';
import { z } from 'zod';

import { BaseApi } from './base-api';

import { EventsHandler } from '@/events-handler';

const CreateAgentProfileSchema = z.object({
  profile: z.any(), // AgentProfile schema
  projectDir: z.string().optional(),
});

const UpdateAgentProfileSchema = z.object({
  profile: z.any(), // AgentProfile schema
  baseDir: z.string().optional(),
});

const DeleteAgentProfileSchema = z.object({
  profileId: z.string().min(1, 'Profile ID is required'),
  baseDir: z.string().optional(),
});

const UpdateAgentProfilesOrderSchema = z.object({
  agentProfiles: z.array(z.any()), // AgentProfile array
});

const SyncAgentProfileSchema = z.object({
  profileId: z.string().min(1, 'Profile ID is required'),
});

export class AgentApi extends BaseApi {
  constructor(private eventsHandler: EventsHandler) {
    super();
  }

  registerRoutes(router: Router): void {
    // GET /agent-profiles
    router.get(
      '/agent-profiles',
      this.handleRequest(async (_, res) => {
        const profiles = await this.eventsHandler.getAllAgentProfiles();
        res.json(profiles);
      }),
    );

    // POST /agent-profile/create
    router.post(
      '/agent-profile/create',
      this.handleRequest(async (req, res) => {
        const { profile, projectDir } = CreateAgentProfileSchema.parse(req.body);
        const profiles = await this.eventsHandler.createAgentProfile(profile, projectDir);
        res.json(profiles);
      }),
    );

    // POST /agent-profile/update
    router.post(
      '/agent-profile/update',
      this.handleRequest(async (req, res) => {
        const { profile } = UpdateAgentProfileSchema.parse(req.body);
        const profiles = await this.eventsHandler.updateAgentProfile(profile);
        res.json(profiles);
      }),
    );

    // POST /agent-profile/delete
    router.post(
      '/agent-profile/delete',
      this.handleRequest(async (req, res) => {
        const { profileId } = DeleteAgentProfileSchema.parse(req.body);
        const profiles = await this.eventsHandler.deleteAgentProfile(profileId);
        res.json(profiles);
      }),
    );

    // POST /agent-profiles/order
    router.post(
      '/agent-profiles/order',
      this.handleRequest(async (req, res) => {
        const { agentProfiles } = UpdateAgentProfilesOrderSchema.parse(req.body);
        await this.eventsHandler.updateAgentProfilesOrder(agentProfiles);
        res.json({ success: true });
      }),
    );

    // GET /agent-profile/sync-status
    router.get(
      '/agent-profile/sync-status',
      this.handleRequest(async (req, res) => {
        const profileId = req.query.profileId as string;
        if (!profileId) {
          res.status(400).json({ error: 'profileId is required' });
          return;
        }
        const status = await this.eventsHandler.getAgentProfileSyncStatus(profileId);
        res.json(status);
      }),
    );

    // POST /agent-profile/sync-md-to-config
    router.post(
      '/agent-profile/sync-md-to-config',
      this.handleRequest(async (req, res) => {
        const { profileId } = SyncAgentProfileSchema.parse(req.body);
        const profiles = await this.eventsHandler.syncAgentProfileMdToConfig(profileId);
        res.json(profiles);
      }),
    );

    // POST /agent-profile/sync-config-to-md
    router.post(
      '/agent-profile/sync-config-to-md',
      this.handleRequest(async (req, res) => {
        const { profileId } = SyncAgentProfileSchema.parse(req.body);
        await this.eventsHandler.syncAgentProfileConfigToMd(profileId);
        res.json({ success: true });
      }),
    );

    // POST /agent-profile/auto-sync
    router.post(
      '/agent-profile/auto-sync',
      this.handleRequest(async (req, res) => {
        const { profileId } = SyncAgentProfileSchema.parse(req.body);
        const result = await this.eventsHandler.autoSyncAgentProfile(profileId);
        res.json(result);
      }),
    );

    // POST /agent-profiles/auto-sync-all
    router.post(
      '/agent-profiles/auto-sync-all',
      this.handleRequest(async (_, res) => {
        const results = await this.eventsHandler.autoSyncAllAgentProfiles();
        res.json(results);
      }),
    );
  }
}
