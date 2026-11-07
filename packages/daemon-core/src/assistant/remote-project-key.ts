/** Directory key of a daemon-managed remote-project checkout. Single derivation shared by the
 *  checkout writer (`managedCheckoutPath`) and the transfer scope check so they cannot drift. */
import { createHash } from 'node:crypto';

export function remoteProjectKey(meshId: string, identity: string): string {
    return createHash('sha256').update(`${meshId}\0${identity}`).digest('hex').slice(0, 24);
}
