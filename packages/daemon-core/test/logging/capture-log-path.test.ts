import { describe, it, expect, afterEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import { getDaemonLogDir, getDaemonCaptureLogPath, DAEMON_CAPTURE_LOG_NAME } from '../../src/logging/logger.js'

// `daemon:restart` failure text must name the file that holds the real startup error.
// A daemon that dies before the structured logger exists writes only to the raw capture
// file (daemon-service.log), never to daemon-<date>.log.
describe('capture log path', () => {
  const original = process.env.ADHDEV_CONFIG_DIR
  afterEach(() => {
    if (original === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = original
  })

  it('is daemon-service.log inside the resolved log dir and follows ADHDEV_CONFIG_DIR', () => {
    const dir = path.join(os.tmpdir(), 'adhdev-capture-path-config')
    process.env.ADHDEV_CONFIG_DIR = dir
    expect(DAEMON_CAPTURE_LOG_NAME).toBe('daemon-service.log')
    expect(getDaemonCaptureLogPath()).toBe(path.join(dir, 'logs', 'daemon-service.log'))
    expect(path.dirname(getDaemonCaptureLogPath())).toBe(getDaemonLogDir())
  })
})
