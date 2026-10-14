import { authenticatedActorObservation } from '../../maintenance/actor-observation.js';
import { defineCommandSpecs } from '../command-registry.js';
import { cooperativeMaintenanceStatus } from '../../maintenance/cooperative-gate.js';

export const cooperativeMaintenanceSpecs = defineCommandSpecs('low', {
    cooperative_maintenance_actor_observe: async (ctx, args) => authenticatedActorObservation(ctx.components().cliManager,args),
    cooperative_maintenance_observe: async (ctx, args) => ({ success: true, observation: await ctx.components().cliManager.observeHeldHostedSessions(args?.nonce) }),
    cooperative_maintenance_status: async (_ctx, args) => ({ ...cooperativeMaintenanceStatus(), nonce: args?.nonce }),
}, { cooperative_maintenance_actor_observe: { sources: ['ipc', 'mesh'], meshSender: 'authenticated_peer' }, cooperative_maintenance_observe: { sources: ['ipc', 'mesh'], meshSender: 'authenticated_peer' }, cooperative_maintenance_status: { sources: ['ipc', 'mesh'], meshSender: 'authenticated_peer' } });
