import { defineCommandSpecs } from '../command-registry.js';
import { cooperativeMaintenanceStatus } from '../../maintenance/cooperative-gate.js';

export const cooperativeMaintenanceSpecs = defineCommandSpecs('low', {
    cooperative_maintenance_status: async (_ctx, args) => ({ ...cooperativeMaintenanceStatus(), nonce: args?.nonce }),
}, { cooperative_maintenance_status: { sources: ['ipc', 'mesh'], meshSender: 'authenticated_peer' } });
