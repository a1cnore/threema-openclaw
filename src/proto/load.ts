import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.join(__dirname, '../../proto');

let _root: protobuf.Root | null = null;

export async function loadProtos(): Promise<protobuf.Root> {
  if (_root) return _root;
  
  _root = new protobuf.Root();
  _root.resolvePath = (_origin: string, target: string) => {
    return path.join(PROTO_DIR, target);
  };
  
  await _root.load([
    'common.proto',
    'md-d2d-rendezvous.proto',
    'md-d2d-join.proto',
    'md-d2d-sync.proto',
    'md-d2d.proto',
    'md-d2m.proto',
    'url-payloads.proto',
  ], { keepCase: false });
  
  return _root;
}

// Convenience typed accessors
export async function getTypes() {
  const root = await loadProtos();
  return {
    // Rendezvous
    RendezvousInit: root.lookupType('rendezvous.RendezvousInit'),
    RrdToRidHello: root.lookupType('rendezvous.Handshake.RrdToRid.Hello'),
    RidToRrdAuthHello: root.lookupType('rendezvous.Handshake.RidToRrd.AuthHello'),
    RrdToRidAuth: root.lookupType('rendezvous.Handshake.RrdToRid.Auth'),
    Nominate: root.lookupType('rendezvous.Nominate'),
    
    // Device Join
    EdToNd: root.lookupType('join.EdToNd'),
    NdToEd: root.lookupType('join.NdToEd'),
    EssentialData: root.lookupType('join.EssentialData'),
    Registered: root.lookupType('join.Registered'),
    Begin: root.lookupType('join.Begin'),
    
    // URL payloads
    DeviceGroupJoinRequestOrOffer: root.lookupType('url.DeviceGroupJoinRequestOrOffer'),
    
    // D2M
    ClientUrlInfo: root.lookupType('d2m.ClientUrlInfo'),
    D2mServerHello: root.lookupType('d2m.ServerHello'),
    D2mClientHello: root.lookupType('d2m.ClientHello'),
    D2mServerInfo: root.lookupType('d2m.ServerInfo'),
    
    // Enums
    root,
  };
}
