import { authenticator } from 'otplib';

authenticator.options = { window: 1, step: 30, digits: 6 };

export const generateMfaSecret = () => authenticator.generateSecret(20);
export const mfaUri = (email: string, secret: string, issuer = 'SampCrew by SAMPLEDGE') => authenticator.keyuri(email, issuer, secret);
export const verifyTotp = (secret: string, code: string) => authenticator.check(code, secret);
export const currentTotp = (secret: string) => authenticator.generate(secret);
