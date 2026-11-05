/**
 * ZKTeco "PUSH" (ADMS) protocol, used by many ZKTeco terminals and by eSSL terminals built on ZKTeco firmware.
 * The device calls the server over plain HTTP:
 *
 *   GET  /iclock/cdata?SN=<serial>&options=all      handshake; the server answers with upload options
 *   POST /iclock/cdata?SN=<serial>&table=ATTLOG     attendance records, one per line, tab separated:
 *                                                   PIN  YYYY-MM-DD HH:MM:SS  status  verify  workcode ...
 *   POST /iclock/cdata?SN=<serial>&table=OPERLOG    operation log (accepted and ignored)
 *   GET  /iclock/getrequest?SN=<serial>[&INFO=...]  polls for commands; doubles as the heartbeat
 *   POST /iclock/devicecmd?SN=<serial>              command results
 *
 * Field meanings vary by model and firmware, so this adapter is marked Preview until validated against each
 * model a customer uses. Every original line is stored with the punch, so nothing is lost if a mapping
 * turns out to be wrong.
 */
import { createHash } from 'node:crypto';
import { zonedTime } from '@crew/contracts';

export interface ParsedPunch {
  sourceEventId: string;
  deviceUserId: string;
  localTime: string;
  capturedAt: number;
  direction: 'in' | 'out' | 'unknown';
  verifyMethod: 'fingerprint' | 'face' | 'card' | 'pin' | 'palm' | 'unknown';
  raw: string;
}

export interface ParseResult {
  punches: ParsedPunch[];
  rejected: { line: string; reason: string }[];
}

// Status codes as commonly documented: 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 overtime-in, 5 overtime-out.
const DIRECTION: Record<string, ParsedPunch['direction']> = { '0': 'in', '1': 'out', '2': 'out', '3': 'in', '4': 'in', '5': 'out' };
// Verify codes differ between firmware families; only the widely shared ones are named, the rest stay "unknown".
const VERIFY: Record<string, ParsedPunch['verifyMethod']> = { '0': 'pin', '1': 'fingerprint', '2': 'card', '15': 'face' };

const LINE = /^([A-Za-z0-9_-]{1,32})\t(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\t([^\t]*))?(?:\t([^\t]*))?/;

/** Parses an ATTLOG upload. Times are the device's local wall-clock time in the device's configured zone. */
export function parseAttlog(body: string, serial: string, timeZone: string, directionFromDevice: boolean): ParseResult {
  const punches: ParsedPunch[] = [];
  const rejected: ParseResult['rejected'] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) {
      rejected.push({ line: line.slice(0, 200), reason: 'unrecognised format' });
      continue;
    }
    const [, pin, date, hh, mm, ss, status = '', verify = ''] = m as unknown as string[];
    if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59 || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      rejected.push({ line: line.slice(0, 200), reason: 'invalid date or time' });
      continue;
    }
    const capturedAt = zonedTime.fromLocal(date!, Number(hh) * 60 + Number(mm), timeZone) + Number(ss) * 1000;
    const localTime = `${date} ${hh}:${mm}:${ss}`;
    punches.push({
      // ATTLOG has no record id, so the identity is the serial, user, time and status (the same record sent twice is one punch).
      sourceEventId: createHash('sha256').update(`${serial.toUpperCase()}|${pin}|${localTime}|${status.trim()}`).digest('hex'),
      deviceUserId: pin!,
      localTime,
      capturedAt,
      direction: directionFromDevice ? DIRECTION[status.trim()] ?? 'unknown' : 'unknown',
      verifyMethod: VERIFY[verify.trim()] ?? 'unknown',
      raw: line.slice(0, 500),
    });
  }
  return { punches, rejected };
}

/** Handshake answer: ask for attendance records, not operation logs or photos, in real time. */
export function handshakeResponse(serial: string): string {
  return [
    `GET OPTION FROM: ${serial}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=9999',
    'ATTPHOTOStamp=None',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    'Realtime=1',
    'Encrypt=None',
    '',
  ].join('\n');
}

/** `INFO=` on getrequest, when the firmware sends it: firmware version, user count, fingerprint count, record count, IP... */
export function parseInfo(info: string | undefined): { firmware: string | null; users: number | null; records: number | null } {
  if (!info) return { firmware: null, users: null, records: null };
  const parts = info.split(',');
  const num = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  return { firmware: parts[0]?.trim().slice(0, 80) || null, users: num(parts[1]), records: num(parts[3]) };
}

/** Builds ATTLOG lines the way a device sends them. Used by the simulator and tests. */
export function attlogLines(rows: { pin: string; local: string; status: 0 | 1 | 2 | 3 | 4 | 5; verify?: number }[]): string {
  return rows.map((r) => `${r.pin}\t${r.local}\t${r.status}\t${r.verify ?? 1}\t0\t0\t0`).join('\n') + '\n';
}
