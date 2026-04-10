/**
 * ADHDev Daemon — unified logger (v2)
 *
 * log level: DEBUG < INFO < WARN < ERROR
 *
 * Features:
 * 1. daemonLog(category, msg, level) — explicit per-category logging
 * 2. installGlobalInterceptor() — Auto-intercept console.log (once on daemon start)
 * 3. Recent log ring buffer — for remote transmission via P2P/WS
 * 4. File logging — ~/Library/Logs/adhdev/daemon.log (10MB rolling)
 *
 * use:
 * import { daemonLog, LOG } from './daemon-logger';
 * LOG.info('CDP', 'Connected to cursor on port 9333');
 * LOG.debug('StatusReport', 'P2P heartbeat sent');
 * LOG.warn('IdeInstance', 'onTick error: ...');
 * LOG.error('Server', 'WebSocket disconnected');
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare function setLogLevel(level: LogLevel): void;
export declare function getLogLevel(): LogLevel;
export declare function getDaemonLogDir(): string;
export declare function getCurrentDaemonLogPath(date?: Date): string;
export interface LogEntry {
    ts: number;
    level: LogLevel;
    category: string;
    message: string;
}
/** Get recent N logs (for remote transmission) */
export declare function getRecentLogs(count?: number, minLevel?: LogLevel): LogEntry[];
/** Ring buffer current size */
export declare function getLogBufferSize(): number;
/**
 * Explicit per-category logging
 * level filter apply, File logging, Ring buffer save
 */
export declare function daemonLog(category: string, msg: string, level?: LogLevel): void;
/**
 * Scoped logger instance for a specific component.
 * Created via LOG.forComponent('CDP:cursor').
 */
export interface ScopedLogger {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    /** Returns a plain (msg: string) => void function at the given level.
     *  Useful as logFn callback for ProviderLoader, DaemonStatusReporter, etc. */
    asLogFn: (level?: LogLevel) => (msg: string) => void;
}
/**
 * LOG — unified logging API
 *
 * Usage:
 *   LOG.info('CDP', 'Connected to cursor on port 9333');
 *   LOG.debug('StatusReport', 'P2P heartbeat sent');
 *
 * Component-scoped logger:
 *   const log = LOG.forComponent('ACP:cursor');
 *   log.info('Session created');
 *   log.debug('Heartbeat');
 *
 * As callback for external components:
 *   new ProviderLoader({ logFn: LOG.forComponent('Provider').asLogFn() });
 *   new DaemonStatusReporter({ logFn: LOG.forComponent('Status').asLogFn() });
 */
export declare const LOG: {
    debug: (category: string, msg: string) => void;
    info: (category: string, msg: string) => void;
    warn: (category: string, msg: string) => void;
    error: (category: string, msg: string) => void;
    /**
     * Create a scoped logger for a specific component.
     * Category is baked in so callers only pass the message.
     */
    forComponent(category: string): ScopedLogger;
};
/**
 * console.log/warn/error global interceptor install
 * Prevent recording in places not using daemonLog.
 * daemon start when 1time call.
 */
export declare function installGlobalInterceptor(): void;
/** current log file path (dateper) */
export declare function getLogPath(): string;
/** LOG_PATH — backward compat (current date file) */
export declare const LOG_PATH: string;
export declare const LOG_DIR_PATH: string;
