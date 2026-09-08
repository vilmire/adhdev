import * as yaml from 'js-yaml';

/**
 * Parse a config file body by extension: `.json` goes through `JSON.parse`,
 * everything else through the YAML loader (YAML is a JSON superset, so this is
 * only an explicit fast path plus stricter errors for `.json`).
 */
export function parseConfigText(path: string, text: string): unknown {
    if (/\.json$/i.test(path)) return JSON.parse(text);
    return yaml.load(text);
}
