import * as Crypto from 'expo-crypto';
import type { Clock } from './outbox';

/**
 * Two clocks: the phone's wall clock (which the person can change) and a monotonic clock that counts from
 * when the app started. The run id tells the server whether two monotonic readings come from the same run.
 */
export const clock: Clock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  runId: Crypto.randomUUID().replace(/-/g, ''),
};

export const randomId = () => Crypto.randomUUID().replace(/-/g, '');
