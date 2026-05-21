const COMPLETE_OSC_11_RESPONSE = /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const UNTERMINATED_OSC_11_RGB_RESPONSE = /\x1b\]11;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}/g;
const BARE_OSC_11_RGB_RESPONSE = /(^|[\r\n])\]11;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\)?(?=$|[\r\n])/g;
const DEVICE_ATTRIBUTE_RESPONSE = /\x1b\[[?>][0-9;]*c/g;

export function sanitizeTerminalInputForProvider(data: string): string {
  return data
    .replace(COMPLETE_OSC_11_RESPONSE, '')
    .replace(UNTERMINATED_OSC_11_RGB_RESPONSE, '')
    .replace(BARE_OSC_11_RGB_RESPONSE, '$1')
    .replace(DEVICE_ATTRIBUTE_RESPONSE, '');
}
