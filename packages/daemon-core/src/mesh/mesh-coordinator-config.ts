/**
 * Hermes / MCP coordinator config helpers
 *
 * Extracted from commands/router.ts (behavior-preserving move). Contains the
 * MCP-server config parse/serialize helpers and the Hermes coordinator base
 * config loading / temp-override stripping / credential-copy helpers.
 *
 * router.ts re-exports every public symbol from here so existing import paths
 * keep working.
 */

import { LOG } from '../logging/logger.js';
import * as yaml from 'js-yaml';
import { homedir } from 'os';
import { join as pathJoin, resolve as pathResolve } from 'path';
import * as fs from 'fs';
import type { MeshCoordinatorConfigFormat } from './mesh-refine-gates.js';

function loadYamlModule(): { load: (input: string) => any; dump: (input: any, options?: Record<string, any>) => string } {
    return yaml as { load: (input: string) => any; dump: (input: any, options?: Record<string, any>) => string };
}

export function getMcpServersKey(format: MeshCoordinatorConfigFormat): 'mcpServers' | 'mcp_servers' {
    return format === 'hermes_config_yaml' ? 'mcp_servers' : 'mcpServers';
}

export function parseMeshCoordinatorMcpConfig(text: string, format: MeshCoordinatorConfigFormat): Record<string, any> {
    if (!text.trim()) return {};
    if (format === 'claude_mcp_json') return JSON.parse(text);
    const parsed = loadYamlModule().load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function serializeMeshCoordinatorMcpConfig(config: Record<string, any>, format: MeshCoordinatorConfigFormat): string {
    if (format === 'claude_mcp_json') return JSON.stringify(config, null, 2);
    return loadYamlModule().dump(config, { noRefs: true, lineWidth: 120 });
}

function resolveHermesUserHome(): string {
    const explicitHome = process.env.HERMES_HOME?.trim();
    return explicitHome || pathJoin(homedir(), '.hermes');
}

export function loadHermesCoordinatorBaseConfig(targetConfigPath: string): { config: Record<string, any>; sourceHome: string; sourceConfigPath: string } {
    const sourceHome = resolveHermesUserHome();
    const sourceConfigPath = pathJoin(sourceHome, 'config.yaml');
    if (!fs.existsSync(sourceConfigPath)) return { config: {}, sourceHome, sourceConfigPath };
    if (pathResolve(sourceConfigPath) === pathResolve(targetConfigPath)) return { config: {}, sourceHome, sourceConfigPath };

    const parsed = parseMeshCoordinatorMcpConfig(fs.readFileSync(sourceConfigPath, 'utf-8'), 'hermes_config_yaml');
    const { mcp_servers: _mcpServers, ...baseConfig } = parsed;
    return { config: baseConfig, sourceHome, sourceConfigPath };
}

export function stripHermesCoordinatorTempModelProviderOverrides(config: Record<string, any>): Record<string, any> {
    const {
        model: _model,
        provider: _provider,
        default_model: _defaultModel,
        defaultProvider: _defaultProvider,
        default_provider: _defaultProviderSnake,
        modelProvider: _modelProvider,
        model_provider: _modelProviderSnake,
        ...sanitized
    } = config;
    const delegation = sanitized.delegation;
    if (delegation && typeof delegation === 'object' && !Array.isArray(delegation)) {
        const {
            model: _delegationModel,
            provider: _delegationProvider,
            modelProvider: _delegationModelProvider,
            model_provider: _delegationModelProviderSnake,
            ...delegationRest
        } = delegation;
        if (Object.keys(delegationRest).length > 0) {
            sanitized.delegation = delegationRest;
        } else {
            delete sanitized.delegation;
        }
    }
    return sanitized;
}

export function copyHermesCoordinatorCredentialFiles(sourceHome: string, targetHome: string) {
    if (pathResolve(sourceHome) === pathResolve(targetHome)) return;
    for (const fileName of ['.env', 'auth.json']) {
        const sourcePath = pathJoin(sourceHome, fileName);
        const targetPath = pathJoin(targetHome, fileName);
        if (!fs.existsSync(sourcePath)) continue;
        try {
            fs.copyFileSync(sourcePath, targetPath);
        } catch (error: any) {
            LOG.warn('MeshCoordinator', `Could not copy Hermes ${fileName} into isolated coordinator home: ${error?.message || error}`);
        }
    }
}

