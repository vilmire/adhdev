import type { ProviderSourceMode } from '../config/config.js';

/**
 * The config-derived ProviderLoader options every construction path must agree
 * on. Extracted because the option list had drifted across the three
 * construction sites (fragmentation audit): the IDE-launch path omitted
 * `userDir`/`sourceMode`, so a configured `providerDir` was honored at daemon
 * boot but silently ignored when launching an IDE. Callers add only their
 * genuinely site-specific options (logFn, daemonVersion, probeStarts).
 */
export function providerLoaderConfigOptions(appConfig: {
  providerDir?: string;
  providerSourceMode?: ProviderSourceMode;
  registryUrl?: string;
  serverUrl?: string;
  providerTarballUrl?: string;
  providerChannel?: string;
  updateChannel?: string;
}): {
  userDir?: string;
  sourceMode?: ProviderSourceMode;
  registryUrl?: string;
  serverUrl?: string;
  providerTarballUrl?: string;
  channel?: string;
  updateChannel?: string;
} {
  return {
    ...(appConfig.providerDir ? { userDir: appConfig.providerDir } : {}),
    ...(appConfig.providerSourceMode ? { sourceMode: appConfig.providerSourceMode } : {}),
    ...(appConfig.registryUrl ? { registryUrl: appConfig.registryUrl } : {}),
    ...(appConfig.serverUrl ? { serverUrl: appConfig.serverUrl } : {}),
    ...(appConfig.providerTarballUrl ? { providerTarballUrl: appConfig.providerTarballUrl } : {}),
    ...(appConfig.providerChannel ? { channel: appConfig.providerChannel } : {}),
    ...(appConfig.updateChannel ? { updateChannel: appConfig.updateChannel } : {}),
  };
}
