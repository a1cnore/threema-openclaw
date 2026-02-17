/**
 * Device Join Protocol — New Device (ND) side.
 * 
 * Receives Begin, BlobData, and EssentialData from the Existing Device (ED)
 * over an established rendezvous connection.
 */
import { getTypes } from './proto/load.js';
import type { RendezvousResult } from './rendezvous.js';

export interface JoinResult {
  identity: string;
  clientKey: Uint8Array;
  serverGroup: string;
  deviceGroupKey: Uint8Array;
  deviceCookie: Uint8Array;
  contacts: Array<{
    identity: string;
    publicKey: Uint8Array;
    firstName?: string;
    lastName?: string;
    nickname?: string;
  }>;
  groups: Array<{
    groupId: Uint8Array;
    creatorIdentity: string;
    name?: string;
  }>;
}

/**
 * Run the device join protocol as the new device.
 */
export async function runDeviceJoin(conn: RendezvousResult): Promise<JoinResult> {
  const types = await getTypes();
  
  const blobs = new Map<string, Uint8Array>();
  let state: 'wait-begin' | 'sync-blobs' | 'done' = 'wait-begin';
  
  console.log('[join] Waiting for device join messages...');
  
  while (state !== 'done') {
    const data = await conn.receive();
    
    let msg;
    try {
      msg = types.EdToNd.decode(data);
    } catch (err) {
      console.error('[join] Failed to decode EdToNd message:', err);
      continue;
    }
    
    const content = msg.content;
    
    if (content === 'begin') {
      if (state !== 'wait-begin') {
        throw new Error('Received Begin in unexpected state');
      }
      console.log('[join] Received Begin — device join in progress');
      state = 'sync-blobs';
    } else if (content === 'blobData') {
      if (state !== 'sync-blobs') {
        throw new Error('Received BlobData in unexpected state');
      }
      const blobData = msg.blobData as { id: Uint8Array; data: Uint8Array };
      const idHex = Buffer.from(blobData.id).toString('hex');
      console.log(`[join] Received BlobData: ${idHex} (${blobData.data.length} bytes)`);
      blobs.set(idHex, blobData.data);
    } else if (content === 'essentialData') {
      console.log('[join] Received EssentialData!');
      
      const ed = msg.essentialData as any;
      const identityData = ed.identityData;
      const deviceGroupData = ed.deviceGroupData;
      
      console.log(`[join]   Identity: ${identityData.identity}`);
      console.log(`[join]   Server Group: ${identityData.cspServerGroup}`);
      console.log(`[join]   Client Key: ${Buffer.from(identityData.ck).toString('hex').slice(0, 16)}...`);
      console.log(`[join]   Device Group Key: ${Buffer.from(deviceGroupData.dgk).toString('hex').slice(0, 16)}...`);
      
      // Parse contacts
      const contacts = (ed.contacts || []).map((ac: any) => {
        const c = ac.contact;
        return {
          identity: c.identity,
          publicKey: c.publicKey,
          firstName: c.firstName,
          lastName: c.lastName,
          nickname: c.nickname,
        };
      });
      console.log(`[join]   Contacts: ${contacts.length}`);
      
      // Parse groups
      const groups = (ed.groups || []).map((ag: any) => {
        const g = ag.group;
        return {
          groupId: g.groupIdentity?.groupId,
          creatorIdentity: g.groupIdentity?.creatorIdentity,
          name: g.name,
        };
      });
      console.log(`[join]   Groups: ${groups.length}`);
      
      // Send Registered message back
      console.log('[join] Sending Registered message...');
      const registered = types.NdToEd.create({
        content: 'registered',
        registered: {},
      });
      const registeredBytes = types.NdToEd.encode(registered).finish();
      conn.send(registeredBytes);
      console.log('[join] Registered sent!');
      
      state = 'done';
      
      return {
        identity: identityData.identity,
        clientKey: identityData.ck,
        serverGroup: identityData.cspServerGroup,
        deviceGroupKey: deviceGroupData.dgk,
        deviceCookie: identityData.cspDeviceCookie,
        contacts,
        groups,
      };
    } else {
      console.warn(`[join] Unknown message content: ${content}`);
    }
  }
  
  throw new Error('Device join protocol ended without essential data');
}
